# Rencana Tahapan Optimasi Efisiensi Nagios Core (Encore)

Dokumen ini merinci rencana teknis bertahap untuk meningkatkan efisiensi codebase Nagios Core 4.x pada tiga area prioritas tertinggi:

1. **Prioritas 1:** Eliminasi bottleneck CGI & flat-file parsing (`status.dat` / `objects.cache`).
2. **Prioritas 2:** Specialized persistent workers untuk mengurangi `fork()` + `exec()` pada check terbanyak.
3. **Prioritas 3:** Penulisan snapshot state & retention (`retention.dat` / `status.dat`) secara non-blocking.

*(Prioritas 4 — dynamic config reload — sengaja dilewati pada roadmap ini untuk menjaga stabilitas manajemen memori core daemon.)*

---

## Prinsip Eksekusi

- **Bertahap & Terisolasi:** Setiap fase dapat dibangun, diuji, dan dirilis secara terpisah tanpa memutus kompatibilitas fitur yang ada.
- **Core Event Loop Tetap Single-Threaded:** Tidak menambahkan multi-threading ke `event_execution_loop()` di `base/events.c` untuk menghindari *race condition* pada global state.
- **Feature-Flagged & Mudah Rollback:** Setiap perubahan perilaku inti dikontrol lewat konfigurasi atau service terpisah sehingga dapat dikembalikan ke mode standar dengan cepat.
- **Berbasis Data (Benchmark-Driven):** Setiap fase diukur terhadap baseline yang sama sebelum dinyatakan selesai.

---

## Fase 0: Persiapan, Build & Baseline Benchmark

**Tujuan:** Memastikan seluruh test suite eksisting hijau dan memiliki angka baseline untuk membandingkan hasil optimasi.

### Langkah Teknis
1. **Verifikasi Build & Test Suite**
   - Jalankan konfigurasi dengan dukungan testing, event broker, dan NERD:
     ```bash
     ./configure --enable-testing --enable-event-broker --enable-nerd
     make all
     make test
     ```
   - Pastikan seluruh test di `t-tap/` (C unit test) dan `t/` (Perl integration test) lulus tanpa error.
2. **Siapkan Lingkungan Load Test Sintetis**
   - Buat generator konfigurasi dummy (misalnya 1.000 host & 10.000 service dengan campuran check cepat dan lambat).
3. **Catat Metrik Baseline**
   - CPU usage rata-rata & puncak (`nagios` daemon + core workers).
   - Jumlah `fork()/detik` (`vmstat` / `pidstat`).
   - Disk write IOPS & bytes/detik untuk `status.dat` dan `retention.dat`.
   - Latency p50/p95/p99 saat 10–50 client mengakses `statusjson.cgi` / `status.cgi` secara simultan.
   - *Check execution latency* dari `nagiostats` (untuk mendeteksi stutter di event loop).

### Kriteria Selesai
- `make test` lulus 100%.
- Dokumen/tabel hasil baseline tersimpan sebagai pembanding Fase 1–3.

---

## Fase 1 (Prioritas 1): Eliminasi Bottleneck CGI & Flat-File Parsing

**Masalah:** Setiap request ke `cgi/status.c` atau `cgi/statusjson.c` men-spawn proses CGI baru dan mem-parse ulang seluruh `objects.cache` dan `status.dat` dari disk (`xdata/xsddefault.c`).

**Arsitektur Target:**
```text
[Daemon Nagios]
   ├── Query Handler (@state) ──► Initial Snapshot (JSON in-memory)
   └── NERD (@nerd subscribe) ──► Real-time Delta Events
                                         │
                                         ▼
                        [Persistent State API Gateway]
                        (In-memory cache + HTTP/JSON API)
                                         │
                                         ▼
                             [Web UI / Integrasi]
```

### Tahap 1A — Ekspos State In-Memory via Query Handler / NEB
- **File terkait:** `base/query-handler.c`, `base/nerd.c`, `common/objects.c`, atau modul baru di `module/`.
- **Langkah:**
  1. Pastikan build mengaktifkan `--enable-nerd` (di `base/nerd.c`, NERD nonaktif secara default sejak 4.4.0).
  2. Tambahkan Query Handler read-only baru (misalnya `@state`) atau NEB module ringan yang mendukung query ringkas:
     - `#state summary` — ringkasan count host/service per state.
     - `#state hosts` / `#state services` — snapshot status objek in-memory (dengan opsi filter state/hostgroup agar payload tetap kecil dan tidak memblokir main thread terlalu lama).
  3. Perluas channel NERD (jika perlu) agar selain `hostchecks` dan `servicechecks`, perubahan *downtime*, *acknowledgement*, dan *comment* juga di-broadcast secara real-time.
  4. Terapkan batas waktu/ukuran respons agar handler di main thread tetap cepat (sesuai batasan di `docs/queryhandlers.dox`).

### Tahap 1B — Bangun Persistent State API Gateway
- **Lokasi baru yang disarankan:** Subdirektori terpisah (mis. `api/` atau service terpisah yang ditulis dalam Go/Rust/C).
- **Langkah:**
  1. Saat startup, gateway terhubung ke Query Handler Unix socket, mengambil snapshot penuh dari `#state`, lalu menyimpannya di cache in-memory.
  2. Membuka koneksi persisten ke `@nerd` untuk menerima *event delta* dan memperbarui cache secara real-time.
  3. Menyediakan endpoint HTTP JSON yang ringan (mendukung filter, pagination, dan otorisasi setara `cgi/cgiauth.c`).
  4. Untuk operasi tulis (*acknowledge*, *schedule downtime*, *force check*), teruskan perintah ke external command file (`nagios.cmd`) atau Query Handler tanpa melewati `cmd.cgi`.
  5. Tambahkan mekanisme *auto-resync* jika koneksi socket ke Nagios terputus/restart.

### Tahap 1C — Cutover & Kurangi/Matikan Penulisan `status.dat`
- **File terkait:** `xdata/xsddefault.c`, `sample-config/nagios.cfg.in`.
- **Langkah:**
  1. Arahkan dashboard/consumer API dari `*.cgi` ke State API Gateway.
  2. Setelah stabil, naikkan `status_update_interval` secara signifikan, atau set `status_file=/dev/null` (sudah didukung secara native di `xdata/xsddefault.c` baris 131) jika CGI lama tidak lagi digunakan.

### Verifikasi & Rollback Fase 1
- **Verifikasi:**
  - Parity check: data JSON dari State API Gateway cocok 100% dengan `statusjson.cgi`.
  - Load test 50 concurrent client: p95 latency turun dari ratusan/ribuan ms menjadi < 20 ms, dan zero CGI process spawn.
  - Disk write untuk `status.dat` turun hingga 0 (atau minimal).
- **Rollback:** Arahkan kembali web server ke CGI lama dan kembalikan `status_file` ke path semula di `nagios.cfg`.

---

## Fase 2 (Prioritas 2): Specialized Persistent Workers

**Masalah:** Core worker standar (`base/workers.c` + `lib/runcmd.c`) melakukan `fork()` + `exec()` untuk setiap eksekusi plugin, menimbulkan overhead CPU dan *context switching* tinggi.

**Keunggulan:** Protokol `@wproc` (`docs/workers.dox`) sudah mendukung routing per-plugin secara native tanpa perlu mengubah core daemon.

### Tahap 2A — Audit Plugin Terbanyak
- Identifikasi 3–4 plugin dengan frekuensi eksekusi tertinggi di lingkungan target (umumnya: `check_icmp` / `check_ping`, `check_tcp`, `check_http`, `check_snmp`).

### Tahap 2B — Implementasi Specialized Worker
- **Referensi di repo:** `docs/workers.dox`, `worker/ping/worker-ping.c`, `lib/worker.c`, `base/workers.c`.
- **Langkah:**
  1. Buat worker persisten (mis. `worker/net-worker/` dalam C atau Go) yang terhubung ke Query Handler socket dan mendaftar dengan format:
     ```text
     @wproc register name=fast-net-worker;max_jobs=1024;plugin=check_icmp;plugin=check_tcp;plugin=check_http
     ```
  2. Implementasikan parser protokol `kvvec` (`key=value\0...\1\0\0\0`) untuk menerima `job_id`, `type`, `command`, dan `timeout`.
  3. Jalankan check secara **in-process & non-blocking** (tanpa `fork/exec`):
     - `check_tcp`: non-blocking socket connect + timeout.
     - `check_http`: persistent HTTP client pool (TLS reuse / connection handling).
     - `check_icmp`: raw ICMP socket (memerlukan `CAP_NET_RAW`).
  4. Pastikan format respons identik dengan kontrak Nagios:
     - `job_id`, `type`, `start`, `stop`, `runtime`, `wait_status` (exit code `0=OK`, `1=WARNING`, `2=CRITICAL`, `3=UNKNOWN`), dan `outstd` (termasuk format perfdata `| metric=val;warn;crit;min;max`).
  5. Jika argumen/flag pada sebuah command tidak dikenali oleh fast-path worker, lakukan *fallback* ke eksekusi binary plugin asli agar 100% kompatibel.

### Tahap 2C — Operasional & Resilience
- Jalankan specialized worker sebagai daemon terpisah (mis. via systemd) dengan *auto-reconnect* ke QH socket saat Nagios di-reload.
- Jika specialized worker mati, Nagios core secara otomatis merutekan job kembali ke core worker bawaan.

### Verifikasi & Rollback Fase 2
- **Verifikasi:**
  - Parity test: bandingkan exit code, output teks, dan perfdata antara plugin asli vs specialized worker untuk skenario OK, WARNING, CRITICAL, UNKNOWN, dan timeout.
  - Load test: ukur penurunan `fork()/detik`, penurunan CPU usage, dan peningkatan maksimum checks/detik.
  - Fault-injection test: matikan worker di tengah load dan pastikan Nagios otomatis fallback tanpa kehilangan check.
- **Rollback:** Hentikan service specialized worker; Nagios langsung kembali menggunakan core worker default tanpa perlu restart.

---

## Fase 3 (Prioritas 3): Non-Blocking State & Retention Persistence

**Masalah:** `xrddefault_save_state_information()` (`xdata/xrddefault.c`) dan `xsddefault_save_status_data()` (`xdata/xsddefault.c`) berjalan sinkron di main thread (`base/events.c`), menyebabkan jeda sesaat (*stutter*) pada event loop saat jumlah objek besar.

### Tahap 3A — Profiling & Audit Efek Samping
- **File terkait:** `base/events.c`, `base/sretention.c`, `xdata/xrddefault.c`, `xdata/xsddefault.c`.
- **Langkah:**
  1. Ukur durasi aktual `save_state_information()` dan `update_all_status_data()` pada konfigurasi benchmark.
  2. Audit seluruh aksi di dalam fungsi save untuk memastikan tidak ada mutasi state yang harus kembali ke parent process (hanya membaca struktur objek di memori lalu menulis ke file temp + `rename()`).

### Tahap 3B — Implementasi Background Copy-on-Write Save
- **File terkait:** `base/config.c`, `include/nagios.h`, `xdata/xrddefault.c`, `xdata/xsddefault.c`, `base/events.c`.
- **Langkah:**
  1. Tambahkan opsi konfigurasi baru di `nagios.cfg` (default nonaktif agar aman):
     - `async_retention_save=0|1`
     - `async_status_save=0|1` (hanya relevan jika `status_file` masih aktif).
  2. Implementasikan mekanisme `fork()` *copy-on-write* (pola mirip Redis `BGSAVE`) pada `xrddefault_save_state_information()`:
     - Simpan `static pid_t retention_save_pid = 0;`. Jika save sebelumnya masih berjalan, lewati siklus ini dan catat log peringatan agar tidak menumpuk.
     - Sebelum `fork()`, flush buffer stdio (`fflush(NULL)`).
     - Di **child process**: tutup file descriptor yang tidak perlu (socket QH/iobroker), tulis ke temp file, `fsync()`, lakukan `rename()` atomik ke `retention_file`, lalu keluar dengan `_exit(0)` (bukan `exit()` agar tidak memicu `atexit` handler atau merusak state parent).
     - Di **parent process**: langsung kembali ke `event_execution_loop()` tanpa menunggu disk I/O.
  3. Tambahkan pembersihan child process non-blocking (`waitpid(retention_save_pid, &status, WNOHANG)`) di loop/signal handler agar tidak ada *zombie process*.
  4. **Pengecualian Shutdown:** Saat `sigshutdown == TRUE` atau `sigrestart == TRUE`, paksa eksekusi **sinkron** (dan tunggu child yang sedang berjalan selesai terlebih dahulu) agar state terakhir dijamin tersimpan sebelum daemon berhenti.

### Tahap 3C — Pengujian Keamanan Memori & Integritas
- Jalankan unit test `t-tap/` dan uji dengan `valgrind` untuk memastikan tidak ada kebocoran FD, *zombie process*, atau korupsi file.
- Bandingkan isi `retention.dat` hasil `async_retention_save=1` vs `async_retention_save=0` (harus identik selain timestamp `created=`).

### Verifikasi & Rollback Fase 3
- **Verifikasi:**
  - *Event loop latency* tidak lagi melonjak saat `EVENT_RETENTION_SAVE` terpicu.
  - Tidak ada zombie process (`ps aux | grep defunct`) setelah ratusan siklus save.
  - Restart/reload daemon memuat ulang state dengan sempurna dari `retention.dat`.
- **Rollback:** Set `async_retention_save=0` dan `async_status_save=0` di `nagios.cfg` lalu reload.

---

## Ringkasan Urutan Eksekusi & Ketergantungan

```text
Fase 0 (Baseline & Benchmark)
   │
   ├──► Fase 1 (Prioritas 1: QH/NERD + State API Gateway + Matikan CGI/status.dat)
   │       └──► Paling terasa untuk user dashboard & disk I/O
   │
   ├──► Fase 2 (Prioritas 2: Specialized Persistent Workers via @wproc)
   │       └──► Bisa dikerjakan paralel dengan Fase 1 (zero core change)
   │
   └──► Fase 3 (Prioritas 3: Async CoW Retention/Status Save)
           └──► Paling aman dikerjakan setelah Fase 1 stabil
```

## Checklist Definition of Done (Keseluruhan)
- [ ] Seluruh unit test & integration test (`make test`) tetap lulus.
- [ ] Setiap fitur baru memiliki unit/integration test tambahan.
- [ ] Perbandingan metrik sebelum vs sesudah (CPU, `fork/s`, disk IOPS, API latency, check latency) terdokumentasi.
- [ ] Prosedur rollback untuk tiap fase sudah diuji.
