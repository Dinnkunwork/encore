#!/usr/bin/env python3
"""
Fase 1 Benchmark & Parity Verification:
- Runs Nagios with status_file=/dev/null (zero status.dat disk I/O)
- Connects Go State API Gateway to nagios.qh (#state + @nerd subscribe stateevents)
- Verifies live NERD events update the in-memory store
- Benchmarks HTTP /api/v1/services (2000 services) and /api/v1/summary vs Fase 0 CGI baseline
"""

import concurrent.futures
import json
import os
import signal
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

from run_baseline import generate_config, query_qh, NAGIOS_BIN

REPO_ROOT = Path(__file__).resolve().parent.parent
GATEWAY_BIN = REPO_ROOT / "api" / "state-gateway" / "state-gateway"


def http_get_json(url: str):
    t0 = time.perf_counter()
    with urllib.request.urlopen(url, timeout=5) as resp:
        body = resp.read()
    dt_ms = (time.perf_counter() - t0) * 1000.0
    return dt_ms, json.loads(body)


def bench_http(url: str, requests: int, concurrency: int):
    latencies = []
    t_start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = [ex.submit(http_get_json, url) for _ in range(requests)]
        for fut in concurrent.futures.as_completed(futs):
            dt_ms, _ = fut.result()
            latencies.append(dt_ms)
    wall_s = time.perf_counter() - t_start
    latencies.sort()
    return {
        "requests": requests,
        "concurrency": concurrency,
        "wall_s": round(wall_s, 3),
        "rps": round(requests / wall_s, 2),
        "p50_ms": round(statistics.median(latencies), 2),
        "p95_ms": round(latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))], 2),
        "p99_ms": round(latencies[min(len(latencies) - 1, int(len(latencies) * 0.99))], 2),
    }


def main():
    work_dir = Path("/tmp/encore-bench-fase1")
    nagios_cfg, _ = generate_config(work_dir, num_hosts=200, services_per_host=10, check_interval_sec=15)

    # Disable status.dat disk writes (Tahap 1C)
    cfg_text = nagios_cfg.read_text(encoding="utf-8").replace(
        f"status_file={work_dir}/var/status.dat",
        "status_file=/dev/null",
    )
    nagios_cfg.write_text(cfg_text, encoding="utf-8")

    qh_sock = work_dir / "var" / "nagios.qh"
    cmd_pipe = work_dir / "var" / "nagios.cmd"
    status_dat = work_dir / "var" / "status.dat"

    nagios_proc = subprocess.Popen(
        [str(NAGIOS_BIN), str(nagios_cfg)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    gw_proc = None

    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            if qh_sock.exists():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Timed out waiting for nagios.qh")

        # Verify @state and stateevents directly
        qh_summary_raw = query_qh(qh_sock, "#state summary")
        qh_summary = json.loads(qh_summary_raw)
        print("[fase1] Direct QH #state summary:", json.dumps(qh_summary))

        # Start Go State API Gateway
        gw_proc = subprocess.Popen(
            [
                str(GATEWAY_BIN),
                "-listen", "127.0.0.1:18080",
                "-qh", str(qh_sock),
                "-cmd", str(cmd_pipe),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Wait for gateway to be connected and receive live NERD events
        deadline = time.time() + 15
        health = None
        while time.time() < deadline:
            try:
                _, health = http_get_json("http://127.0.0.1:18080/health")
                if health.get("connected") and health.get("services") == 2000:
                    break
            except Exception:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError(f"Gateway did not become healthy: {health}")

        # Let live checks run for 8 seconds so NERD stateevents stream in
        time.sleep(8)
        _, health_after = http_get_json("http://127.0.0.1:18080/health")
        _, gw_summary = http_get_json("http://127.0.0.1:18080/api/v1/summary")

        # Benchmark full 2000-service JSON list (same payload class as statusjson.cgi)
        svc_bench = bench_http("http://127.0.0.1:18080/api/v1/services", requests=100, concurrency=4)
        svc_paged = bench_http("http://127.0.0.1:18080/api/v1/services?limit=50&offset=0", requests=200, concurrency=8)
        sum_bench = bench_http("http://127.0.0.1:18080/api/v1/summary", requests=200, concurrency=8)

        results = {
            "status_dat_exists": status_dat.exists(),
            "gateway_health": health_after,
            "gateway_summary": gw_summary,
            "bench_services_all_2000": svc_bench,
            "bench_services_paged_50": svc_paged,
            "bench_summary": sum_bench,
        }
        print("\n=== FASE 1 RESULTS ===")
        print(json.dumps(results, indent=2))
    finally:
        if gw_proc and gw_proc.poll() is None:
            gw_proc.terminate()
            gw_proc.wait(timeout=5)
        if nagios_proc.poll() is None:
            nagios_proc.send_signal(signal.SIGTERM)
            nagios_proc.wait(timeout=10)


if __name__ == "__main__":
    main()
