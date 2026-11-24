#!/usr/bin/env python3
"""
Fase 2 Benchmark & Fault-Injection Verification:
- Runs Nagios (200 hosts, 2000 services, 15s interval) + Go Specialized Worker (check_mock.sh, check_tcp, check_http)
- Compares forks/sec and check execution time against Fase 0 baseline (150.93 forks/s, 528ms exec)
- Performs fault-injection: kills go-worker mid-run and verifies Nagios survives and falls back cleanly.
"""

import json
import signal
import subprocess
import time
from pathlib import Path

from run_baseline import generate_config, query_qh, read_proc_forks, get_process_tree_stats, NAGIOS_BIN, NAGIOSTATS_BIN

REPO_ROOT = Path(__file__).resolve().parent.parent
GO_WORKER_BIN = REPO_ROOT / "worker" / "go-worker" / "go-worker"


def main():
    work_dir = Path("/tmp/encore-bench-fase2")
    nagios_cfg, _ = generate_config(work_dir, num_hosts=200, services_per_host=10, check_interval_sec=15)

    qh_sock = work_dir / "var" / "nagios.qh"
    nagios_proc = subprocess.Popen(
        [str(NAGIOS_BIN), str(nagios_cfg)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    worker_proc = None

    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            if qh_sock.exists():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Timed out waiting for nagios.qh")

        # Launch Go specialized worker BEFORE heavy check wave starts
        worker_proc = subprocess.Popen(
            [
                str(GO_WORKER_BIN),
                "-name", "encore-fast-worker",
                "-qh", str(qh_sock),
                "-plugins", "check_mock.sh,check_tcp,check_http,check_dummy",
                "-max-jobs", "512",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        time.sleep(0.5)

        forks_before = read_proc_forks()
        t_start = time.perf_counter()
        print("[fase2] Running 20s load with Go Specialized Worker...")
        time.sleep(20)
        elapsed_s = time.perf_counter() - t_start
        forks_after = read_proc_forks()
        total_forks = forks_after - forks_before
        forks_per_sec = round(total_forks / elapsed_s, 2)

        qh_summary = json.loads(query_qh(qh_sock, "#state summary"))
        proc_count, rss_kb = get_process_tree_stats(nagios_proc.pid)

        ns_out = subprocess.run(
            [
                str(NAGIOSTATS_BIN),
                "-c", str(nagios_cfg),
                "-m",
                "-d", "NUMHOSTS,NUMSERVICES,AVGACTHSTLAT,AVGACTSVCLAT,AVGACTHSTEXT,AVGACTSVCEXT,NUMSVCACTCHK1M,NUMHSTACTCHK1M",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        ).stdout.strip().splitlines()
        ns_keys = [
            "NUMHOSTS", "NUMSERVICES", "AVGACTHSTLAT_ms", "AVGACTSVCLAT_ms",
            "AVGACTHSTEXT_ms", "AVGACTSVCEXT_ms", "NUMSVCACTCHK1M", "NUMHSTACTCHK1M"
        ]
        nagiostats = dict(zip(ns_keys, ns_out))

        # Fault-injection test: kill go-worker and verify Nagios stays alive & falls back!
        print("[fase2] Fault-injection: terminating go-worker...")
        worker_proc.terminate()
        _, worker_stderr = worker_proc.communicate(timeout=5)
        time.sleep(3)
        nagios_alive_after_kill = nagios_proc.poll() is None
        post_kill_summary = json.loads(query_qh(qh_sock, "#state summary")) if nagios_alive_after_kill else None

        results = {
            "runtime": {
                "elapsed_sec": round(elapsed_s, 2),
                "total_forks": total_forks,
                "forks_per_sec": forks_per_sec,
                "nagios_tree_count": proc_count,
                "nagios_tree_rss_mb": round(rss_kb / 1024.0, 2),
            },
            "qh_summary": qh_summary,
            "nagiostats": nagiostats,
            "fault_injection": {
                "nagios_survived_worker_kill": nagios_alive_after_kill,
                "post_kill_hosts_up": post_kill_summary["hosts"]["up"] if post_kill_summary else -1,
            },
            "worker_log_tail": worker_stderr.strip().splitlines()[-5:],
        }
        print("\n=== FASE 2 RESULTS ===")
        print(json.dumps(results, indent=2))
    finally:
        if worker_proc and worker_proc.poll() is None:
            worker_proc.terminate()
            worker_proc.wait(timeout=5)
        if nagios_proc.poll() is None:
            nagios_proc.send_signal(signal.SIGTERM)
            nagios_proc.wait(timeout=10)


if __name__ == "__main__":
    main()
