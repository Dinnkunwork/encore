# Fase 0 — Laporan Baseline Build, Test & Benchmark

**Tanggal:** 2026-11-24  
**Commit Base:** `98d275a5` (`master`)  
**Build Flags:** `./configure --enable-testing --enable-event-broker --enable-nerd`  
*(Catatan: `--enable-testing` mengaktifkan `-O0 -fprofile-arcs -ftest-coverage`; untuk perbandingan antar-fase pastikan menggunakan build flag yang sama.)*

---

## 1. Status Environment & Dependensi
- **Tersedia:** `gcc`, `make`, `perl`, `prove`, `python3`, `openssl`, `epoll` (IOBroker).
- **Belum terpasang (opsional):** `libgd-dev` (hanya untuk `statusmap.cgi` / `trends.cgi` / `histogram.cgi`), `gperf`, `valgrind`, `go`.

## 2. Status Test Suite Baseline
| Test Suite | Hasil | Catatan |
| :--- | :--- | :--- |
| `lib/` C tests | **PASS (100%)** | Semua unit test `libnagios` lulus |
| `t-tap/` C unit tests | **PASS (6.723 / 6.723)** | 11 file test lulus seluruhnya |
| `t/` Perl integration tests | **490 / 491 PASS** | 1 gagal di `618cgisecurity.t` (hanya karena `statusmap.cgi` tidak dibangun tanpa `libgd-dev`) |

## 3. Hasil Benchmark Baseline (`bench/run_baseline.py`)

**Skenario:** 200 host, 2.000 service, `check_interval=15s`, durasi beban 20 detik, plugin mock `/bin/sh`, 24 request CGI dengan 4 worker paralel.

| Kategori | Metrik | Nilai Baseline |
| :--- | :--- | :--- |
| **Startup** | Config pre-flight verify (`nagios -v`) | `38.96 ms` |
| **Proses & Memori** | Process tree count (daemon + workers) | `14 proses` |
| **Proses & Memori** | Total RSS (`nagios` + workers) | `66.13 MB` |
| **Worker / Fork** | Total `fork()` dalam 20.2 detik | `3.049 forks` |
| **Worker / Fork** | Laju `fork()` | **`150.93 forks/detik`** |
| **Check Latency** | Avg Active Host Check Latency | `2 ms` |
| **Check Latency** | Avg Active Service Check Latency | `18 ms` |
| **Check Exec** | Avg Active Service Check Execution | `528 ms` |
| **Flat Files** | `objects.cache` | `1.65 MB` (`1652.9 KB`) |
| **Flat Files** | `retention.dat` | `2.83 MB` (`2833.3 KB`) |
| **CGI (`statusjson.cgi`)** | Throughput (4 concurrent) | **`3.87 req/s`** |
| **CGI (`statusjson.cgi`)** | Latency p50 / p95 / p99 | **`1038 ms` / `1415 ms` / `1438 ms`** |
| **CGI (`status.cgi`)** | Throughput (4 concurrent) | **`5.08 req/s`** |
| **CGI (`status.cgi`)** | Latency p50 / p95 / p99 | **`882 ms` / `1211 ms` / `1248 ms`** |

## 4. Verifikasi Subsistem untuk Fase 1 & 2
- **Query Handler aktif:** `wproc`, `nerd`, `help`, `echo`, `core`.
- **NERD channels aktif:** `hostchecks`, `servicechecks`, `opathchecks`.

## 5. Temuan Utama dari Baseline
1. **Bottleneck CGI Terkonfirmasi (Target Fase 1):** Baru dengan 2.000 service dan 4 user simultan, `statusjson.cgi` sudah butuh **> 1,4 detik (p95)** dan hanya melayani **3,87 req/s** karena re-spawn proses + re-parse flat file tiap request.
2. **Bottleneck `fork/exec` Terkonfirmasi (Target Fase 2):** Hanya 2.000 service dengan interval 15 detik sudah menghasilkan **~151 `fork()/detik`** di OS.
3. **Ukuran Snapshot (Target Fase 3):** Pada 2.000 service saja `retention.dat` sudah **2,83 MB** (akan membengkak linear ke puluhan MB di 20.000+ service).

---

## 6. Hasil Fase 1 (Prioritas 1: `@state` QH + NERD `stateevents` + Go State API Gateway)

**Perubahan yang diimplementasikan:**
- Core C: Query Handler `#state` (`summary`, `hosts`, `services`) di `base/query-handler.c` dan channel NERD NDJSON `stateevents` di `base/nerd.c`.
- Gateway Go: `api/state-gateway` (single binary 7,8 MB, zero external dependency, in-memory cache + auto-resync + HTTP JSON API + external command forwarder).
- Konfigurasi: `status_file=/dev/null` (zero disk write `status.dat`).

**Perbandingan Baseline Fase 0 vs Fase 1 (200 host, 2.000 service):**

| Metrik | Fase 0 (CGI Baseline) | Fase 1 (Go State Gateway) | Peningkatan |
| :--- | :--- | :--- | :--- |
| **Disk write `status.dat`** | Ditulis penuh tiap 5 detik | **0 byte (`status_file=/dev/null`)** | **-100% I/O** |
| **Full 2.000 services JSON (4 concurrent)** | `3.87 req/s` | **`40.88 req/s`** | **10,6x throughput** |
| **Full 2.000 services p50 / p95** | `1038 ms` / `1415 ms` | **`55.33 ms` / `143.01 ms`** | **-94,7% p50 / -89,9% p95** |
| **Paged 50 services JSON (8 concurrent)** | *(tidak tersedia di CGI)* | **`261.04 req/s`** (p50 `21.87 ms`) | — |
| **Summary JSON (8 concurrent)** | *(tidak tersedia di CGI)* | **`601.72 req/s`** (p50 `11.99 ms`) | — |
| **Real-time NERD Sync** | — | `1.102` event diterapkan (`200 up + 902 ok`, 100% cocok) | Real-time |

---

## 7. Hasil Fase 2 (Prioritas 2: Specialized Persistent Worker di Go via `@wproc`)

**Perubahan yang diimplementasikan:**
- **Core C Bugfix ([base/workers.c](file:///home/dinnkun/projects/encore/base/workers.c)):** Memperbaiki bug upstream pada `remove_worker()` dan `get_wproc_list()` ketika satu *specialized worker* mendaftar untuk banyak plugin sekaligus lalu disconnect — kini semua pointer dibersihkan dengan aman dan Nagios otomatis fallback ke core worker standar.
- **Go Specialized Worker ([worker/go-worker/main.go](file:///home/dinnkun/projects/encore/worker/go-worker/main.go)):** Single binary Go (7,6 MB, zero external dependency) yang mendaftar via `@wproc register`, mengeksekusi `check_tcp`, `check_http`, dan `check_dummy` secara **in-process & non-blocking** (goroutines + HTTP connection pooling), dengan fallback otomatis ke `/bin/sh` jika ada flag/plugin tak dikenal.

**Perbandingan Baseline Fase 0 vs Fase 2 (200 host, 2.000 service, interval 15 detik, durasi 20 detik):**

| Metrik | Fase 0 (Core Worker `fork/exec`) | Fase 2 (Go Specialized Worker) | Peningkatan |
| :--- | :--- | :--- | :--- |
| **Total `fork()` (20 detik)** | `3.049 forks` | **`25 forks`** | **-99,2% forks** |
| **Laju `fork()`** | `150,93 forks/detik` | **`1,25 forks/detik`** | **-99,2%** |
| **Avg Service Check Exec** | `528 ms` | **`0 ms` (< 1 ms)** | **>500× lebih cepat** |
| **Avg Host Check Exec** | `545 ms` | **`0 ms` (< 1 ms)** | **>500× lebih cepat** |
| **Avg Service Check Latency** | `18 ms` | **`4 ms`** | **-77,8%** |
| **Completed Checks (20 detik)** | — | `3.027` (`fast_path=3.027`, `fallback=0`) | 200 UP, 2.000 OK |
| **Fault-Injection (kill worker)** | — | **Nagios tetap hidup & fallback otomatis** | PASS |

---

## 8. Hasil Fase 3 (Prioritas 3: Non-Blocking Copy-on-Write State & Retention Persistence)

**Perubahan yang diimplementasikan:**
- **Konfigurasi ([include/nagios.h](file:///home/dinnkun/projects/encore/include/nagios.h), [base/utils.c](file:///home/dinnkun/projects/encore/base/utils.c), [base/config.c](file:///home/dinnkun/projects/encore/base/config.c)):** Menambahkan opsi opt-in `async_retention_save=0|1` dan `async_status_save=0|1` (default `0` untuk backward compatibility).
- **Copy-on-Write Background Save ([xdata/xrddefault.c](file:///home/dinnkun/projects/encore/xdata/xrddefault.c), [xdata/xsddefault.c](file:///home/dinnkun/projects/encore/xdata/xsddefault.c)):** Saat opsi aktif pada siklus normal, daemon melakukan `fflush(NULL)` + `fork()`, child menulis ke file temp lalu `rename()` atomik dan keluar dengan `_exit()`, sementara parent langsung kembali ke event loop. Saat `sigshutdown` / `sigrestart`, sistem otomatis menunggu child yang sedang berjalan lalu melakukan *synchronous save* agar state terakhir dijamin utuh.
- **Zero-Zombie Reaping ([base/events.c](file:///home/dinnkun/projects/encore/base/events.c), [base/utils.c](file:///home/dinnkun/projects/encore/base/utils.c)):** Memanggil `reap_async_save_children(FALSE)` secara non-blocking tepat setelah `iobroker_poll()` di `event_execution_loop()`.

**Hasil Verifikasi (`bench/bench_fase3.py`, 200 host, 2.000 service):**

| Pengujian | Hasil |
| :--- | :--- |
| Config pre-flight (`async_retention_save=1`, `async_status_save=1`) | **PASS** |
| Async `status.dat` (2s interval) | **PASS** (`2.778,4 KB`, 200 host, 2.000 service) |
| Async `retention.dat` (3× trigger `SAVE_STATE_INFORMATION`) | **PASS** (`2.743,9 KB`, 200 host, 2.000 service) |
| Final sync `retention.dat` pada graceful shutdown | **PASS** (`2.797,3 KB`, 200 host, 2.000 service) |
| Zombie process selama runtime | **`0` zombie** |
| State restore setelah restart daemon | **PASS** (`200/200 UP`, `2.000/2.000 OK`) |
