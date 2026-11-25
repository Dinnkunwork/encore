# Encore v8 — SSE Real-Time Push, SSL Expiry Worker, Scheduled SLA Digest, Discovery & NOC Mode Plan

Dokumen ini merangkum rencana pengembangan **Encore v8** yang dirancang dengan prinsip **zero external dependencies** dan **beban lebih ringan** dibanding polling tradisional.

---

## 1. Real-Time Push ke Browser via SSE (`Server-Sent Events`) + Sound/Desktop Alert

- **Tujuan:** Menggantikan polling agresif setiap 3 detik menjadi push real-time `< 50 ms` langsung dari stream NERD `stateevents`, sehingga traffic & beban CPU turun ~80–90%.
- **Backend (`api/state-gateway/sse.go`, `main.go`):**
  - `EventBroker` ringan berbasis `sync.RWMutex` + channel per klien (`cap 32`, non-blocking drop untuk klien lambat) + heartbeat `: ping` tiap 25 detik.
  - Terhubung langsung ke `StateStore.ApplyHostEvent` & `ApplyServiceEvent` untuk mem-broadcast delta ringkas (`kind`, `host`, `service`, `state`, `prev_state`, `state_type`, `output`).
  - Endpoint `GET /api/v1/stream` (RBAC `viewer`+, dikecualikan dari `gzipMiddleware` agar `http.Flusher` mengirim event tanpa buffering).
- **Frontend (`core.js`, `monitor.js`, `index.html`):**
  - Membuka `EventSource('/api/v1/stream')` dengan auto-reconnect; indikator sidebar menampilkan **`Live (SSE)`**.
  - Saat SSE tersambung, fallback polling otomatis turun ke 30 detik (bukan 3 detik).
  - Event baru men-trigger refresh ter-debounce (`250ms`) pada tampilan aktif.
  - **Optional Alert Chime & Desktop Notification:** Tombol toggle bel (`Alerts: OFF/ON`) di topbar (default **OFF**). Jika dinyalakan, setiap insiden **HARD CRITICAL / DOWN** baru membunyikan chime Web Audio API (tanpa file audio) dan/atau Desktop Notification browser.

---

## 2. SSL Certificate Expiry Check In-Process di `encore-go-worker`

- **Tujuan:** Mendeteksi sertifikat HTTPS yang hampir kadaluarsa secara *in-process* (`0 fork/exec`, `~0 ms` tambahan) dan otomatis merekam metrik `cert_days` ke grafik Time-Series v7.
- **Worker (`worker/go-worker/main.go`):**
  - Tambah dukungan flag `-C warn[,crit]` (contoh: `check_http -H example.com -S -C 30,14`) pada `execCheckHTTP`:
    - Membaca `PeerCertificates[0].NotAfter` langsung dari koneksi TLS.
    - Menghitung sisa hari (`daysLeft`), mengevaluasi ambang batas `warn` & `crit` (termasuk jika sudah expired → `CRITICAL`).
    - Menghasilkan output & `perf_data` standar Nagios:
      `OK - Certificate 'example.com' valid for 64 days (expires 2027-01-28) | cert_days=64;30;14;0`
  - Tambah unit test `TestCheckHTTPSSLCertExpiry` di `worker/go-worker/main_test.go` menggunakan sertifikat `crypto/x509` in-memory.
- **Dashboard (`manage.js`):**
  - Tambah tombol preset **`SSL Cert`** (`check_http!-S -C 30,14`) di modal `+ Add Service`.

---

## 3. Scheduled Automated SLA Report Digest (Email & Webhook)

- **Tujuan:** Mengirim ringkasan SLA & insiden secara rutin (harian/mingguan) ke email manajemen atau grup Telegram/Slack/Discord menggunakan engine `reports.go` & `notify.go` yang sudah ada.
- **Backend (`api/state-gateway/digest.go`):**
  - Konfigurasi tersimpan di `/usr/local/nagios/etc/encore.d/encore-digest.json`:
    - `enabled`, `frequency` (`daily` / `weekly`), `day_of_week` (`0=Sun..6=Sat`, default `1=Mon`), `send_time` (`HH:MM`, default `08:00`), `window_days` (`1`, `7`, `30`), `hostgroup` (opsional), `send_email`, `send_webhook`, `last_sent_date`.
  - Background scheduler (cek tiap 60 detik, dedup per hari): memanggil `computeAvailability()`, menyusun ringkasan HTML Email (KPI Overall SLA, HARD Incidents, Avg MTTR, 10 objek SLA terendah) dan ringkasan teks untuk Telegram/Slack/Discord, lalu mengirim via `Notifier`.
  - Endpoint (RBAC `admin`):
    - `GET/POST /api/v1/reports/digest`
    - `POST /api/v1/reports/digest/send-now` (kirim segera untuk verifikasi/ad-hoc).
- **Frontend (`reports.js`):**
  - Tombol **`Schedule Digest`** di toolbar `Reports → SLA & Charts` yang membuka modal konfigurasi + tombol **`Send Now`**.

---

## 4. Quick Network Discovery / Port Probe (Guardrailed, On-Demand)

- **Tujuan:** Mempercepat onboarding server baru dengan memindai IP/subnet dan langsung menyarankan Service Template yang cocok.
- **Backend (`api/state-gateway/discovery.go`):**
  - **Guardrail Ketat (0% saat idle, aman di jaringan):**
    - Khusus role **`admin`** (`403` untuk role lain).
    - Maksimal **254 target** (1 IP, daftar IP koma, atau CIDR hingga `/24`).
    - Worker pool terbatas (**32 goroutine**), TCP dial timeout **700 ms/port**, batas total **15 detik**.
  - Memindai port standar (`22`, `80`, `443`, `5693` NCPA, `3306`, `5432`) + reverse DNS opsional.
  - Otomatis menandai apakah host sudah terdaftar di Managed Config dan menyarankan template (`5693` → `linux-ncpa-basic`, `80/443` → `web-https-stack`).
  - Endpoint: `POST /api/v1/discovery/scan`.
- **Frontend (`manage.js`):**
  - Tombol **`Discover`** di `Manage → Objects` → masukkan subnet/IP → lihat hasil host aktif & port terbuka → centang host → **1-klik `Add Selected to Draft`** (beserta template yang disarankan).

---

## 5. NOC Wallboard / TV Mode (Zero Server Overhead)

- **Tujuan:** Tampilan layar penuh kontras tinggi untuk monitor TV ruang NOC / server 24/7.
- **Frontend (`app.css`, `index.html`, `core.js`):**
  - Tombol **`TV Mode`** di topbar (dan shortcut `Shift+T`, keluar via `Esc` atau tombol `Exit TV Mode` mengambang).
  - Murni CSS (`body.tv-mode`): menyembunyikan sidebar, search box, dan kontrol config; memperbesar KPI Cards, Fleet Health Map, dan tabel Unhandled Problems; masuk ke `Overview` dan menggunakan Fullscreen API bila diizinkan browser.

---

## 6. Security Headers & Native HTTPS/TLS Hardening

- **Backend (`api/state-gateway/main.go`):**
  - Tambah `securityHeadersMiddleware`:
    - `X-Content-Type-Options: nosniff`
    - `X-Frame-Options: DENY`
    - `Referrer-Policy: same-origin`
    - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - Tambah flag opsional **`-tls-cert`** dan **`-tls-key`** pada `encore-state-gateway`: bila keduanya diisi, server langsung berjalan via HTTPS (`srv.ListenAndServeTLS`) dengan cookie `Secure` otomatis aktif.
- **Dokumentasi (`docs/DEPLOYMENT_GUIDE.md`):**
  - Tambah contoh pengaktifan Native TLS (`-tls-cert`/`-tls-key`) dan snippet Reverse Proxy Nginx/Caddy HTTPS.

---

## 7. Fix Bug Edit & Paste Service Template (`manage.js`)

- **Akar Masalah yang Ditemukan:**
  1. **Tabrakan delimiter `|` pada `saveTemplateForm()` ([manage.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/manage.js#L504)):** Editor template saat ini memakai `<textarea>` yang memecah baris dengan `line.split('|')`. Padahal command NCPA Disk **mengandung karakter `|`** (contoh: `check_ncpa!disk/logical/|/used_percent!-w 80 -c 90`), sehingga saat disimpan command langsung terpotong rusak!
  2. **Gagal simpan saat paste format tanpa `|` atau karakter terlarang (`;`, `{`, `}`, `\r`):** Ketika user menempelkan baris hasil copy dari Guide/dokumen (pemisah spasi/tab, bukan `|`), `parts[1]` (`check_command`) menjadi kosong atau mengandung karakter `\r`/`;`, sehingga ditolak backend `400 Bad Request` dan error hanya tampil sebentar di toast (tidak terlihat jelas di modal).
- **Solusi Permanen:**
  - Ganti `<textarea>` raw pipe-delimited di modal **Edit / New Template** menjadi **Structured Row Editor** (tiap baris memiliki 3 input terpisah: `Service Name`, `Check Command` dengan autocomplete, dan `Interval`, plus tombol `+ Add Row`, preset cepat, dan hapus baris) sehingga karakter `|` di dalam command NCPA **100% aman tidak pernah terpotong**.
  - Sediakan tombol opsional **`Paste Bulk`** dengan smart parser yang otomatis membersihkan `\r`, mengenali pemisah ` | ` (menjaga `|` internal command), `Tab`, maupun 2+ spasi (seperti copy langsung dari `Guide → NCPA`), serta menampilkan pesan error validasi **langsung di dalam modal**.

---

## 8. Rebranding Menyeluruh: Nagios → Encore (Zero-Breaking Strategy)

Agar seluruh tampilan dan kode bersih menggunakan nama **Encore** **tanpa membuat server produksi Anda (`/usr/local/nagios/...`) error saat update**:

### A. Rebrand Penuh UI, Laporan, Email & Kode Go (100% Aman, Zero-Downtime)
- **Seluruh Web UI (`web/index.html`, `web/login.html`, `web/js/*.js`):**
  - Mengganti seluruh teks `"Nagios"`, `"Nagios Core"`, `"Nagios Event Log"`, `"Nagios perf_data"`, `"Reload Nagios"`, `"Nagios .cfg"` menjadi **"Encore Engine"**, **"Encore Event Log"**, **"Encore Metrics"**, **"Reload Encore"**, **"Legacy .cfg"** *(URL download paket resmi NCPA `repo.nagios.com` di Guide dipertahankan hanya sebagai URL repositori eksternal agar `apt`/`dnf` tetap bekerja)*.
- **Laporan, Email, Webhook & Log (`api/state-gateway/*.go`, `worker/go-worker/*.go`):**
  - Seluruh judul laporan HTML/PDF, komentar file `.cfg` hasil generate, pesan error validasi, nama fungsi & variabel internal Go (`encoreBin`, `encoreCfg`, `encoreLog`, `parseEncoreLogLine`, `ImportLegacyCfg`, dll.) diubah ke **Encore**.
- **CLI Flag Alias (Backward-Compatible):**
  - Tambah flag baru `-encore-bin`, `-encore-cfg`, `-encore-log` di `encore-state-gateway` sambil **tetap menerima flag lama** (`-nagios-bin`, `-nagios-cfg`, `-nagios-log`) agar unit systemd Anda yang sedang berjalan tidak crash saat upgrade.

### B. Rebrand Binary & Service C Engine (Opsional — Terkendali)
- Menambahkan target build `encore` di `Makefile` / `base/Makefile` (menghasilkan binary `base/encore` dan `encore.service` / `/usr/local/encore/` opsional) tanpa merusak kompatibilitas plugin & NEB API C engine.

---

## 9. Urutan Implementasi & Verifikasi

| Tahap | Cakupan | File Utama |
|---|---|---|
| **Tahap 1 — SSL Expiry In-Process (`go-worker`) + Go Rebrand** | Flag `-C warn[,crit]` + unit test `TestCheckHTTPSSLCertExpiry` + rebrand pesan/simbol Go | `worker/go-worker/main.go`, `worker/go-worker/main_test.go` |
| **Tahap 2 — SSE Broker, Security Headers, Native TLS & Flag Alias** | `sse.go`, `securityHeadersMiddleware`, `-tls-cert`/`-tls-key`, flag `-encore-*` (alias kompatibel) | `api/state-gateway/sse.go`, `api/state-gateway/main.go` |
| **Tahap 3 — Scheduled SLA Digest & Network Discovery** | `digest.go` (scheduler + email/webhook formatter + API), `discovery.go` (guardrailed `/24` scanner + API) | `api/state-gateway/digest.go`, `api/state-gateway/discovery.go` |
| **Tahap 4 — Frontend: SSE, Sound Alert, TV Mode, Digest, Discovery, Fix Template Editor & Full UI Rebrand** | `EventSource` + bell alert toggle + `TV Mode` CSS, modal `Schedule Digest`, modal `Discover Hosts`, preset `SSL Cert`, **Structured Row Editor + Smart Paste**, **100% rebrand tampilan → Encore** | `index.html`, `app.css`, `core.js`, `monitor.js`, `manage.js`, `reports.js`, `guide.js` |
| **Verifikasi & Push** | Unit tests (`go-worker` 6/6, `state-gateway` 9/9), build kedua binary, `node --check`, audit tidak ada branding lama bocor di UI, update `DEPLOYMENT_GUIDE.md`, commit & push | `main_test.go`, `docs/DEPLOYMENT_GUIDE.md` |
