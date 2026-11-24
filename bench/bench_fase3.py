#!/usr/bin/env python3
"""
Fase 3 Verification & Benchmark:
- Tests async_status_save=1 and async_retention_save=1 (Copy-on-Write background dump)
- Verifies atomic status.dat and retention.dat integrity (host & service counts)
- Verifies ZERO zombie processes across multiple async save cycles
- Verifies clean restart & state restore from retention.dat
"""

import json
import os
import signal
import subprocess
import time
from pathlib import Path

from run_baseline import generate_config, query_qh, NAGIOS_BIN


def count_zombies(root_pid: int) -> int:
    zombies = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text().split()
            state = stat[2]
            ppid = int(stat[3])
            if ppid == root_pid and state == "Z":
                zombies += 1
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
            continue
    return zombies


def count_blocks(path: Path):
    hosts = 0
    services = 0
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            s = line.strip()
            if s == "host {" or s == "hoststatus {":
                hosts += 1
            elif s == "service {" or s == "servicestatus {":
                services += 1
    return hosts, services


def main():
    work_dir = Path("/tmp/encore-bench-fase3")
    nagios_cfg, _ = generate_config(work_dir, num_hosts=200, services_per_host=10, check_interval_sec=15)

    # Enable async_status_save=1, async_retention_save=1, and fast 2s status_update_interval
    cfg_text = nagios_cfg.read_text(encoding="utf-8").replace(
        "status_update_interval=5",
        "status_update_interval=2\nasync_status_save=1\nasync_retention_save=1",
    )
    nagios_cfg.write_text(cfg_text, encoding="utf-8")

    # Verify config syntax accepts the new directives
    subprocess.run([str(NAGIOS_BIN), "-v", str(nagios_cfg)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    qh_sock = work_dir / "var" / "nagios.qh"
    cmd_pipe = work_dir / "var" / "nagios.cmd"
    status_dat = work_dir / "var" / "status.dat"
    retention_dat = work_dir / "var" / "retention.dat"

    proc = subprocess.Popen([str(NAGIOS_BIN), str(nagios_cfg)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            if qh_sock.exists() and cmd_pipe.exists():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Timed out waiting for nagios.qh / nagios.cmd")

        # Let multiple async status saves (every 2s) and checks run
        time.sleep(8)

        # Trigger 3 back-to-back async retention saves via external command
        for _ in range(3):
            with open(cmd_pipe, "w", encoding="utf-8") as f:
                f.write(f"[{int(time.time())}] SAVE_STATE_INFORMATION;\n")
            time.sleep(1.5)

        # Give one more status save cycle to ensure any child is reaped
        time.sleep(2.5)
        zombies_during_run = count_zombies(proc.pid)

        status_exists = status_dat.exists()
        status_kb = round(status_dat.stat().st_size / 1024.0, 1) if status_exists else 0
        st_hosts, st_svcs = count_blocks(status_dat) if status_exists else (0, 0)

        ret_exists = retention_dat.exists()
        ret_kb = round(retention_dat.stat().st_size / 1024.0, 1) if ret_exists else 0
        rt_hosts, rt_svcs = count_blocks(retention_dat) if ret_exists else (0, 0)

        pre_shutdown_summary = json.loads(query_qh(qh_sock, "#state summary"))

        # Graceful shutdown (must run synchronous final retention save cleanly)
        proc.send_signal(signal.SIGTERM)
        rc = proc.wait(timeout=15)
        if rc != 0:
            raise RuntimeError(f"Nagios exited with code {rc}")

        # Verify retention.dat written on shutdown
        ret_final_kb = round(retention_dat.stat().st_size / 1024.0, 1)
        rt_final_hosts, rt_final_svcs = count_blocks(retention_dat)

        # Restart Nagios and verify it restores state from retention.dat
        proc2 = subprocess.Popen([str(NAGIOS_BIN), str(nagios_cfg)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.time() + 15
            while time.time() < deadline:
                if qh_sock.exists():
                    break
                time.sleep(0.1)
            time.sleep(0.5)
            restored_summary = json.loads(query_qh(qh_sock, "#state summary"))
        finally:
            proc2.send_signal(signal.SIGTERM)
            proc2.wait(timeout=10)

        results = {
            "config_verify": "PASS",
            "async_status_dat": {
                "exists": status_exists,
                "size_kb": status_kb,
                "hosts": st_hosts,
                "services": st_svcs,
            },
            "async_retention_dat_live": {
                "exists": ret_exists,
                "size_kb": ret_kb,
                "hosts": rt_hosts,
                "services": rt_svcs,
            },
            "final_retention_dat": {
                "size_kb": ret_final_kb,
                "hosts": rt_final_hosts,
                "services": rt_final_svcs,
            },
            "zombies_during_run": zombies_during_run,
            "pre_shutdown_summary": pre_shutdown_summary,
            "restored_after_restart_summary": restored_summary,
        }
        print("\n=== FASE 3 RESULTS ===")
        print(json.dumps(results, indent=2))

        assert st_hosts == 200 and st_svcs == 2000, f"status.dat count mismatch: {st_hosts}/{st_svcs}"
        assert rt_hosts == 200 and rt_svcs == 2000, f"async retention.dat count mismatch: {rt_hosts}/{rt_svcs}"
        assert rt_final_hosts == 200 and rt_final_svcs == 2000, "final retention.dat count mismatch"
        assert zombies_during_run == 0, f"Found {zombies_during_run} zombie processes!"
        assert restored_summary["hosts"]["up"] >= pre_shutdown_summary["hosts"]["up"], "State was not restored on restart!"
        print("[fase3] ALL ASSERTIONS PASSED!")
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)


if __name__ == "__main__":
    main()
