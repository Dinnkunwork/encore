#!/usr/bin/env python3
"""
Fase 0 Baseline Benchmark Harness for Nagios Core (Encore).
Generates a synthetic config in /tmp/encore-bench, runs base/nagios,
measures CPU, forks/s, file sizes, nagiostats latency, QH/NERD health,
and concurrent CGI (statusjson.cgi / status.cgi) p50/p95/p99 latency.
"""

import argparse
import concurrent.futures
import json
import os
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
NAGIOS_BIN = REPO_ROOT / "base" / "nagios"
NAGIOSTATS_BIN = REPO_ROOT / "base" / "nagiostats"
STATUSJSON_CGI = REPO_ROOT / "cgi" / "statusjson.cgi"
STATUS_CGI = REPO_ROOT / "cgi" / "status.cgi"


def read_proc_forks() -> int:
    with open("/proc/stat", "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("processes "):
                return int(line.split()[1])
    return 0


def query_qh(sock_path: Path, query: str) -> str:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(3.0)
        s.connect(str(sock_path))
        s.sendall(query.encode("utf-8") + b"\x00")
        chunks = []
        while True:
            try:
                data = s.recv(4096)
                if not data:
                    break
                chunks.append(data)
            except socket.timeout:
                break
        return b"".join(chunks).decode("utf-8", errors="replace").strip("\x00\n")


def generate_config(work_dir: Path, num_hosts: int, services_per_host: int, check_interval_sec: int):
    if work_dir.exists():
        shutil.rmtree(work_dir)
    for sub in ("etc", "var", "var/spool/checkresults", "var/archives", "plugins"):
        (work_dir / sub).mkdir(parents=True, exist_ok=True)

    # Lightweight shell plugin
    plugin = work_dir / "plugins" / "check_mock.sh"
    plugin.write_text(
        "#!/bin/sh\n"
        'echo "OK - synthetic check $1 $2 | latency=1.2ms;50;100;0;200"\n'
        "exit 0\n",
        encoding="utf-8",
    )
    plugin.chmod(0o755)

    nagios_cfg = work_dir / "etc" / "nagios.cfg"
    nagios_cfg.write_text(
        f"""log_file={work_dir}/var/nagios.log
cfg_file={work_dir}/etc/objects.cfg
object_cache_file={work_dir}/var/objects.cache
status_file={work_dir}/var/status.dat
status_update_interval=5
nagios_user={os.environ.get('USER', 'dinnkun')}
nagios_group={os.environ.get('USER', 'dinnkun')}
check_external_commands=1
command_file={work_dir}/var/nagios.cmd
query_socket={work_dir}/var/nagios.qh
lock_file={work_dir}/var/nagios.lock
temp_file={work_dir}/var/nagios.tmp
temp_path={work_dir}/var
event_broker_options=-1
log_rotation_method=n
log_archive_path={work_dir}/var/archives
use_syslog=0
interval_length=1
retain_state_information=1
state_retention_file={work_dir}/var/retention.dat
retention_update_interval=1
check_result_path={work_dir}/var/spool/checkresults
max_concurrent_checks=0
execute_service_checks=1
execute_host_checks=1
enable_notifications=0
enable_event_handlers=0
enable_flap_detection=1
process_performance_data=0
""",
        encoding="utf-8",
    )

    cgi_cfg = work_dir / "etc" / "cgi.cfg"
    cgi_cfg.write_text(
        f"""main_config_file={nagios_cfg}
use_authentication=0
authorized_for_all_services=*
authorized_for_all_hosts=*
authorized_for_system_information=*
authorized_for_configuration_information=*
""",
        encoding="utf-8",
    )

    lines = [
        """define timeperiod {
    timeperiod_name 24x7
    alias           24x7
    sunday          00:00-24:00
    monday          00:00-24:00
    tuesday         00:00-24:00
    wednesday       00:00-24:00
    thursday        00:00-24:00
    friday          00:00-24:00
    saturday        00:00-24:00
}
define command {
    command_name    check_mock_host
    command_line    """ + str(plugin) + """ host $HOSTNAME$
}
define command {
    command_name    check_mock_svc
    command_line    """ + str(plugin) + """ svc $SERVICEDESC$
}
define contact {
    contact_name    admin
    alias           Admin
    host_notifications_enabled 0
    service_notifications_enabled 0
    host_notification_period 24x7
    service_notification_period 24x7
    host_notification_options n
    service_notification_options n
    host_notification_commands check_mock_host
    service_notification_commands check_mock_svc
}
"""
    ]

    for h in range(1, num_hosts + 1):
        hname = f"bench-host-{h:04d}"
        lines.append(
            f"""define host {{
    host_name               {hname}
    alias                   {hname}
    address                 127.0.0.1
    check_command           check_mock_host
    max_check_attempts      3
    check_interval          {check_interval_sec}
    retry_interval          5
    check_period            24x7
    contacts                admin
    notification_interval   60
    notification_period     24x7
}}
"""
        )
        for s in range(1, services_per_host + 1):
            lines.append(
                f"""define service {{
    host_name               {hname}
    service_description     svc-{s:03d}
    check_command           check_mock_svc
    max_check_attempts      3
    check_interval          {check_interval_sec}
    retry_interval          5
    check_period            24x7
    contacts                admin
    notification_interval   60
    notification_period     24x7
}}
"""
            )

    (work_dir / "etc" / "objects.cfg").write_text("".join(lines), encoding="utf-8")
    return nagios_cfg, cgi_cfg


def run_cgi_once(binary: Path, cgi_cfg: Path, query_string: str) -> float:
    env = os.environ.copy()
    env["REQUEST_METHOD"] = "GET"
    env["QUERY_STRING"] = query_string
    env["NAGIOS_CGI_CONFIG"] = str(cgi_cfg)
    env["REMOTE_USER"] = "admin"
    t0 = time.perf_counter()
    res = subprocess.run(
        [str(binary)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    dt = (time.perf_counter() - t0) * 1000.0
    if not res.stdout:
        raise RuntimeError(f"Empty output from {binary.name}")
    return dt


def bench_cgi(binary: Path, cgi_cfg: Path, query_string: str, requests: int, concurrency: int):
    latencies = []
    t_start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = [ex.submit(run_cgi_once, binary, cgi_cfg, query_string) for _ in range(requests)]
        for fut in concurrent.futures.as_completed(futs):
            latencies.append(fut.result())
    wall_s = time.perf_counter() - t_start
    latencies.sort()
    p50 = statistics.median(latencies)
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))]
    p99 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.99))]
    return {
        "requests": requests,
        "concurrency": concurrency,
        "wall_s": round(wall_s, 3),
        "rps": round(requests / wall_s, 2),
        "p50_ms": round(p50, 2),
        "p95_ms": round(p95, 2),
        "p99_ms": round(p99, 2),
    }


def get_process_tree_stats(root_pid: int):
    rss_kb = 0
    count = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text().split()
            pid = int(stat[0])
            ppid = int(stat[3])
            if pid == root_pid or ppid == root_pid:
                count += 1
                status = (entry / "status").read_text()
                for line in status.splitlines():
                    if line.startswith("VmRSS:"):
                        rss_kb += int(line.split()[1])
                        break
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
            continue
    return count, rss_kb


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hosts", type=int, default=200)
    parser.add_argument("--services-per-host", type=int, default=10)
    parser.add_argument("--check-interval", type=int, default=15)
    parser.add_argument("--duration", type=int, default=20)
    parser.add_argument("--cgi-requests", type=int, default=24)
    parser.add_argument("--cgi-concurrency", type=int, default=4)
    parser.add_argument("--work-dir", type=Path, default=Path("/tmp/encore-bench"))
    args = parser.parse_args()

    total_services = args.hosts * args.services_per_host
    print(f"[bench] Generating config: {args.hosts} hosts, {total_services} services...")
    nagios_cfg, cgi_cfg = generate_config(
        args.work_dir, args.hosts, args.services_per_host, args.check_interval
    )

    # Verify config
    t_verify = time.perf_counter()
    subprocess.run([str(NAGIOS_BIN), "-v", str(nagios_cfg)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    verify_ms = round((time.perf_counter() - t_verify) * 1000.0, 2)
    print(f"[bench] Config pre-flight verify: {verify_ms} ms")

    qh_sock = args.work_dir / "var" / "nagios.qh"
    status_dat = args.work_dir / "var" / "status.dat"
    objects_cache = args.work_dir / "var" / "objects.cache"
    retention_dat = args.work_dir / "var" / "retention.dat"

    forks_before = read_proc_forks()
    t_start = time.perf_counter()
    proc = subprocess.Popen(
        [str(NAGIOS_BIN), str(nagios_cfg)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        # Wait for QH socket and status.dat
        deadline = time.time() + 15
        while time.time() < deadline:
            if qh_sock.exists() and status_dat.exists() and status_dat.stat().st_size > 1024:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Timed out waiting for Nagios QH socket / status.dat")

        qh_help = query_qh(qh_sock, "#help list")
        nerd_list = query_qh(qh_sock, "#nerd list")
        print(f"[bench] QH handlers:\n{qh_help}")
        print(f"[bench] NERD channels:\n{nerd_list}")

        print(f"[bench] Running load for {args.duration}s...")
        time.sleep(args.duration)

        elapsed_s = time.perf_counter() - t_start
        forks_after = read_proc_forks()
        total_forks = forks_after - forks_before
        forks_per_sec = round(total_forks / elapsed_s, 2)
        proc_count, rss_kb = get_process_tree_stats(proc.pid)
        status_dat_kb_live = round(status_dat.stat().st_size / 1024.0, 1) if status_dat.exists() else 0
        objects_cache_kb_live = round(objects_cache.stat().st_size / 1024.0, 1) if objects_cache.exists() else 0

        # Capture nagiostats
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

        # Benchmark CGI
        print(f"[bench] Benchmarking statusjson.cgi ({args.cgi_requests} req, c={args.cgi_concurrency})...")
        statusjson_res = bench_cgi(
            STATUSJSON_CGI, cgi_cfg, "query=servicelist&details=true",
            args.cgi_requests, args.cgi_concurrency
        )
        print(f"[bench] Benchmarking status.cgi ({args.cgi_requests} req, c={args.cgi_concurrency})...")
        status_cgi_res = bench_cgi(
            STATUS_CGI, cgi_cfg, "host=all",
            args.cgi_requests, args.cgi_concurrency
        )

        # Trigger graceful shutdown so retention.dat is written
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=15)

        results = {
            "scenario": {
                "hosts": args.hosts,
                "services": total_services,
                "check_interval_sec": args.check_interval,
                "duration_sec": args.duration,
            },
            "startup": {
                "preflight_verify_ms": verify_ms,
            },
            "runtime": {
                "elapsed_sec": round(elapsed_s, 2),
                "total_forks": total_forks,
                "forks_per_sec": forks_per_sec,
                "process_tree_count": proc_count,
                "process_tree_rss_mb": round(rss_kb / 1024.0, 2),
            },
            "files_kb": {
                "objects_cache_kb": objects_cache_kb_live,
                "status_dat_kb": status_dat_kb_live,
                "retention_dat_kb": round(retention_dat.stat().st_size / 1024.0, 1) if retention_dat.exists() else 0,
            },
            "nagiostats": nagiostats,
            "cgi_statusjson": statusjson_res,
            "cgi_status_html": status_cgi_res,
            "qh_handlers": qh_help.splitlines(),
            "nerd_channels": nerd_list.splitlines(),
        }
        print("\n=== BASELINE JSON ===")
        print(json.dumps(results, indent=2))
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
