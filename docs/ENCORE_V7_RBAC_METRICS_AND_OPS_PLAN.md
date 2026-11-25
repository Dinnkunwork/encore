# Encore v7 — Multi-User RBAC, Login Page, Time-Series Metrics & Ops Automation Plan

Dokumen ini merangkum rencana pengembangan **Encore v7** yang mencakup sistem autentikasi multi-user + RBAC standar industri, halaman login modern, grafik metrik historis (`perf_data`), jadwal maintenance berulang (*recurring downtime*), routing notifikasi per hostgroup, export/import backup via browser, serta *escaping hardening*.

---

## 1. Multi-User Authentication, Login Page & Standard-Practice RBAC

### 1.1 Role-Based Access Control (3 Role Standar — Principle of Least Privilege)
| Capability | `viewer` (Read-Only) | `operator` (NOC) | `admin` (Full) |
|---|:---:|:---:|:---:|
| Lihat `Overview`, `Inventory`, `Problems`, `Reports`, `Metrics`, `Guide` | Ya | Ya | Ya |
| Export Laporan (`CSV`, `PDF/HTML`, `JSON`) | Ya | Ya | Ya |
| Force Check, Acknowledge, Schedule/Cancel Downtime, Recurring Downtime | Tidak | Ya | Ya |
| Edit `Manage` (Hosts, Services, Templates, Commands, Scripts, Groups) | Tidak | Tidak | Ya |
| `Validate`, `Apply & Reload`, `Discard`, `Backup/Restore/Rollback` | Tidak | Tidak | Ya |
| Akses `Secrets ($USERn$)`, `Notifications`, `Manage Users` | Tidak | Tidak | Ya |
| Ganti password akun sendiri & Logout | Ya | Ya | Ya |

### 1.2 Keamanan Standar Industri (100% Go Stdlib — Zero External Dependency)
- **File Penyimpanan (`api/state-gateway/auth.go`):**
  - Disimpan di `/usr/local/nagios/etc/encore.d/encore-users.json` dengan permission **`0600`**.
- **Password Hashing:**
  - Menggunakan **PBKDF2-HMAC-SHA256** (pure Go `crypto/hmac` + `crypto/sha256`), **16-byte random salt** (`crypto/rand`), **100.000 iterasi**, dan verifikasi `subtle.ConstantTimeCompare` (tidak pernah menyimpan plaintext).
- **Session Management:**
  - Cookie `encore_session` berisi 32-byte random token (`crypto/rand`), flags: **`HttpOnly`**, **`SameSite=Lax`**, **`Path=/`**, dan **`Secure`** otomatis saat via HTTPS / `X-Forwarded-Proto: https`.
  - Session TTL default **12 jam** (sliding) dengan dukungan *Logout* & *Revoke Sessions* saat password diubah atau akun dinonaktifkan.
- **Anti Brute-Force Rate Limiter:**
  - Sliding window per IP (maks. **10 percobaan gagal / 5 menit** → HTTP `429 Too Many Requests`).
- **Kompatibilitas & Bootstrap:**
  - Saat `-auth-user` & `-auth-pass` diberikan dan `encore-users.json` belum ada, gateway otomatis membuat akun `admin` pertama dari flag tersebut.
  - Tetap mendukung **HTTP Basic Auth** (`Authorization: Basic ...`) diverifikasi terhadap user store untuk script/curl/automation.
  - Endpoint **`GET /healthz`** tetap publik bebas auth untuk healthcheck probe.
- **Audit Log dengan Identitas Aktor (`Actor`):**
  - Setiap aksi di `AuditEntry` mencatat `actor` (`username (role)`), sehingga jelas siapa yang melakukan ACK, Downtime, Edit Config, Apply, atau Manage User.

### 1.3 Login Page & User Management UI
- **Halaman Login Modern (`web/login.html`):**
  - Desain bersih bertema Encore (logo, dukungan Light/Dark theme, pesan error ramah, *focus-first* username/password, redirect otomatis setelah login).
  - Request browser yang belum login ke `/` otomatis diarahkan ke `/login`; request API mengembalikan `401 Unauthorized`.
- **User Menu di Topbar/Sidebar:**
  - Menampilkan nama user + badge role (`ADMIN`, `OPERATOR`, `VIEWER`), tombol **Change Password**, dan **Logout**.
  - UI secara dinamis menyembunyikan menu/tombol yang tidak sesuai role (dan backend tetap memvalidasi `403 Forbidden` sebagai pertahanan utama).
- **Tab `Manage → Users` (khusus `admin`):**
  - Tabel daftar user (`username`, `display_name`, `role`, `status`, `last_login`).
  - Modal `+ Add User`, `Edit Role / Status`, `Reset Password`, dan `Delete User` (dengan proteksi: **tidak boleh menghapus/menonaktifkan admin aktif terakhir**).

---

## 2. Review & Pembenahan Charts + Grafik Time-Series Metrik (`perf_data` Historis)

- **Review Kondisi Saat Ini:**
  - Grafik SLA saat ini sangat berguna untuk kepatuhan uptime, namun ketika kondisi 100% OK hanya tampil balok hijau datar tanpa visibilitas gejala awal (mis. lonjakan CPU/RAM/latency sebelum menyentuh CRITICAL).
- **Backend (`api/state-gateway/metrics.go`):**
  - Mem-parse `perf_data` format Nagios standar (`'label'=val[UOM];[warn];[crit];[min];[max]`) secara otomatis dari stream NERD `stateevents` tanpa perlu database eksternal (InfluxDB/Graphite).
  - Menyimpan *in-memory ring buffer* per `(host, service, metric)` hingga **7 hari** (resolusi penuh 24 jam, downsampling ringan untuk >24 jam) dan menyimpan snapshot gzipped (`encore-metrics.json.gz`) secara periodik setiap 5 menit + saat graceful shutdown agar data bertahan saat restart.
  - Endpoint baru:
    - `GET /api/v1/metrics?host=H&service=S&range=1h|6h|24h|7d` — mengembalikan deret titik waktu, unit, garis threshold `warn`/`crit`, serta statistik `min`, `avg`, `max`, `last`.
- **Frontend (Pure SVG Area + Line Charts yang Lebih Relevan):**
  - **Service Detail Drawer:** Menampilkan grafik garis tren metrik terkini (`1h / 6h / 24h`) langsung di dalam drawer saat menginspeksi service.
  - **Tab Baru `Reports → Metrics`:** Pilih **Host → Service → Rentang (`1h / 6h / 24h / 7d`)** untuk melihat seluruh grafik metrik (CPU %, RAM %, Disk %, HTTP Latency, RTA Ping) dengan *gradient area fill*, sumbu Y otomatis sesuai unit, garis threshold `WARN` (kuning) & `CRIT` (merah) putus-putus, serta stat strip `Last / Avg / Min / Max`.
  - **Pembenahan `Reports → SLA` & `Overview`:** Tambah garis target SLA `99.9%` pada trend chart SLA, plus ringkasan *Avg Exec Time / Latency* di `Overview` agar gejala lambat terlihat sebelum terjadi outage.

---

## 3. Recurring Downtime (Jadwal Maintenance Rutin)

- **Backend (`api/state-gateway/recurring.go`):**
  - Menyimpan jadwal di `/usr/local/nagios/etc/encore.d/encore-recurring-dt.json`:
    - `id`, `name`, `target_type` (`host` / `service` / `hostgroup`), `host`, `service`, `hostgroup`, `days` (`0=Sun..6=Sat`), `start_time` (`HH:MM`), `duration_min`, `comment`, `enabled`.
  - Background scheduler (cek tiap 60 detik) otomatis mengirim `SCHEDULE_HOST_DOWNTIME` / `SCHEDULE_SVC_DOWNTIME` ke `nagios.cmd` saat jadwal masuk (dengan dedup per hari agar tidak pernah dobel).
  - Endpoint: `GET/POST/DELETE /api/v1/downtimes/recurring` (memerlukan role `operator` atau `admin`).
- **Frontend (`monitor.js` — di `Problems → Downtimes`):**
  - Menampilkan daftar **Recurring Maintenance Schedules** di bawah *Active Downtimes*, lengkap dengan tombol `+ Add Schedule` (pilih hari, jam mulai, durasi, target), toggle ON/OFF, dan delete dengan `encoreConfirm`.

---

## 4. Notification Routing per Hostgroup

- **Backend (`api/state-gateway/notify.go`):**
  - Tambah `Routes []NotifyRoute` di `NotifyConfig`:
    - `id`, `name`, `hostgroup` (mis. `db-prod`, `web-servers`, atau `*`), `recipients []string`, `webhook_enabled`, `webhook_type`, `webhook_url`, `webhook_chat_id`, `enabled`.
  - Saat alert dipicu, `Notifier` memeriksa keanggotaan hostgroup target via `StateStore` dan mengirim ke seluruh route yang cocok (jika tidak ada route cocok, fallback ke konfigurasi global).
- **Frontend (`manage.js` — di `Manage → Notifications`):**
  - Panel **Hostgroup Routing Rules** (`Instant Save`) dengan tombol `+ Add Route`, pilih Hostgroup, tentukan penerima Email dan/atau Webhook (Telegram/Slack/Discord) khusus untuk grup tersebut, serta tombol `Test Route`.

---

## 5. Import Legacy Nagios Core (`.cfg`), Backup Export/Import & `jsEsc` Hardening

### 5.1 Import Config Nagios Core Lama dari Server Lain (`.cfg`)
- **Tujuan:** Mempermudah migrasi dari server Nagios Core 3.x/4.x lama tanpa perlu input ulang satu per satu.
- **Backend (`api/state-gateway/nagios_import.go`):**
  - Mendukung upload 1 atau banyak file `.cfg` (`hosts.cfg`, `services.cfg`, `commands.cfg`, `hostgroups.cfg`, `servicegroups.cfg`, `contacts.cfg`) **maupun paste langsung teks `.cfg`**.
  - **Smart Parser:**
    - Mengenali blok `define host`, `define service`, `define command`, `define hostgroup`, `define servicegroup`, `define contact`.
    - Melewati blok template abstrak (`register 0`).
    - Otomatis memecah `host_name web-01,web-02` (comma-separated) menjadi service terpisah per host, serta mengekspansi `hostgroup_name` ke anggota hostgroup yang ada.
  - Endpoint:
    - `POST /api/v1/config/import/nagios?dry_run=1` — mengembalikan preview lengkap (jumlah & daftar `hosts`, `services`, `commands`, `groups`, `contacts` yang baru vs bentrok).
    - `POST /api/v1/config/import/nagios` — menerapkan ke **Draft** (`pending_changes = true`) dengan opsi `overwrite: false|true`, sehingga operator bisa **Review Diff → Validate (`nagios -v`) → Apply & Reload** dengan aman.
- **Frontend (`Manage → Objects` & `System → Backups`):**
  - Modal **`Import Nagios .cfg`** (upload multi-file `.cfg` atau paste teks, klik *Preview*, pilih *Skip Existing* / *Overwrite*, lalu *Import to Draft*).

### 5.2 Download & Upload/Restore Backup JSON di Browser
- **Backend (`config_api.go`):**
  - `GET /api/v1/config/backups/download?name=...` (atau `name=current` untuk konfigurasi aktif) → download file `.json` backup.
  - `POST /api/v1/config/backups/import` → upload file `.json` backup Encore, preview jumlah objek, lalu simpan sebagai draft (`pending_changes = true`).
- **Frontend (`manage.js` — di `System → Backups`):**
  - Tombol **Download Current Config**, tombol **Download** di tiap baris backup, dan tombol **Import Encore JSON**.

### 5.3 `jsEsc()` Escaping Hardening
- Tambah helper `jsEsc(s)` di [core.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/core.js) untuk meng-escape backslash, kutip tunggal (`'`), dan kutip ganda (`"`) pada seluruh parameter string dalam `onclick="..."`.

---

## 6. 5 Tema Elegan & Integrasi Asset Baru (`encore-art-templates` + `encore-icons.js`)

### 6.1 Theme Switcher 5 Tema Elegan (Sinkron di Dashboard & `/login`)
1. **`light` — Crisp Light:** Putih bersih, aksen biru tajam, ideal untuk siang hari & laporan.
2. **`dark` — Midnight Slate:** Abu-biru gelap nyaman untuk ruang NOC 24/7.
3. **`cyber` — Encore Cyber:** Navy gelap (`#0B1020`) + aksen neon cyan (`#22E3FF`) & violet (`#B26BFF`) + pola `circuit-tile.png` ultra-halus — serasi dengan palet `encore-icons.js`.
4. **`nord` — Nordic Frost:** Biru-abu kalem rendah silau ala Arctic/Nord.
5. **`emerald` — Terminal Ops:** Obsidian gelap + aksen emerald (`#10B981`) + pola `stars-tile.png` ultra-halus bernuansa server room.

### 6.2 Integrasi Asset Baru (Ringan, `< 95 KB` Total, `image-rendering: pixelated`)
- **`assets/encore-icons.js` → `web/js/encore-icons.js`:**
  - Web component `<encore-icon>` untuk logo brand beranimasi (`name="logo" live`), ikon navigasi & header yang hidup saat hover, serta loader (`name="loader" live`).
- **`assets/encore-art-templates/mascots/*.svg` → `web/assets/mascots/`:**
  - `bot-ok.svg` (All Systems Operational di Overview & Problems), `bot-empty.svg` (Empty States), `bot-search.svg` (Search/Quick Jump tidak ketemu), `bot-403.svg` (RBAC Access Denied), `bot-404.svg` (Not Found), `bot-503.svg` (Gateway Disconnected).
- **`assets/encore-art-templates/scenes/` & `tiles/` → `web/assets/scenes/` & `web/assets/tiles/`:**
  - `radar-bg-1920x1080.png` & `serverroom-bg-1920x1080.png` sebagai backdrop elegan halaman `/login` dengan kartu *glassmorphism* yang tajam.
  - `circuit-tile.png` & `stars-tile.png` sebagai tekstur background halus pada tema `Encore Cyber` & `Terminal Ops`.

---

## 7. Urutan Implementasi & Verifikasi

| Tahap | Cakupan | File Utama |
|---|---|---|
| **Tahap 1 — Multi-User Auth, RBAC & Login Page** | `auth.go` (PBKDF2, sessions, rate-limit, RBAC middleware, user CRUD), `web/login.html` (dengan `radar-bg`), `Manage → Users`, role-aware UI & Audit actor | `auth.go`, `main.go`, `web/login.html`, `core.js`, `manage.js` |
| **Tahap 2 — Time-Series Metrics & Chart Polish** | `metrics.go` (parser + 7d ring-buffer + gzip snapshot + API), SVG Area/Line charts di Service Drawer & `Reports → Metrics`, garis target 99.9% SLA & latency insight | `metrics.go`, `main.go`, `monitor.js`, `reports.js` |
| **Tahap 3 — Legacy Nagios `.cfg` Import & Backup Export/Import** | `nagios_import.go` (multi-file/paste parser + dry-run preview + apply to draft), Download/Import JSON backup, `jsEsc()` hardening | `nagios_import.go`, `config_api.go`, `core.js`, `manage.js` |
| **Tahap 4 — Recurring Downtime & Hostgroup Routing** | `recurring.go` (scheduler + CRUD API + UI di Downtimes), Hostgroup Routing di `notify.go` + UI di `Manage → Notifications` | `recurring.go`, `notify.go`, `monitor.js`, `manage.js` |
| **Tahap 5 — 5 Tema Elegan & Asset Integration** | Copy & embed `encore-icons.js`, `mascots/*.svg`, `scenes/*bg*.png`, `tiles/*.png`; 5 tema CSS + theme selector dropdown; update User Guide | `app.css`, `index.html`, `web/assets/`, `guide.js` |
| **Verifikasi & Push** | Unit tests lengkap (RBAC 401/403, PBKDF2, login/logout, metrics parser, legacy `.cfg` import, recurring scheduler, routing, backup import), `go build`, `node --check`, commit & push | `main_test.go` |
