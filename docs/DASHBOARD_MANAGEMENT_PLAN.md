# Rencana Tahapan: Full Management via Encore Web Dashboard

Dokumen ini merinci arsitektur dan tahapan untuk menjadikan **Encore Web Dashboard** (`api/state-gateway`) sebagai pusat manajemen penuh — mulai dari CRUD konfigurasi (**Hosts, Services, Commands, Contacts, Groups**) hingga kontrol operasional (**Downtime, Acknowledge, Toggle Checks/Notifications, Validate & Reload**) tanpa perlu mengedit file `.cfg` secara manual di server.

---

## 1. Arsitektur Aman: Managed Config Directory + Atomic Validate & Reload

Mengedit file `.cfg` Nagios yang ditulis tangan secara langsung sangat rawan merusak sintaks. Solusi paling bersih, aman, dan deterministik adalah pola **Managed Config Store**:

```text
[Encore Web Dashboard (UI)]
        │  CRUD JSON / Validate / Apply
        ▼
[encore-state-gateway (Go)]
   1. Simpan state terstruktur di: /usr/local/nagios/etc/encore.d/encore-managed.json
   2. Generate .cfg bersih ke staging dir (encore-hosts.cfg, encore-services.cfg, dll.)
   3. Jalankan pre-flight check:  nagios -v /usr/local/nagios/etc/nagios.cfg
      ├── GAGAL  ──► Tolak perubahan & tampilkan error detail di UI (config live tetap aman)
      └── SUKSES ──► Backup snapshot lama ──► Atomic rename() ke encore.d/
                     ──► Kirim RESTART_PROGRAM ke nagios.cmd (reload tanpa perlu sudo!)
                     ──► Auto-resync in-memory state via #state & NERD
```

**Satu-satunya setup di `nagios.cfg`:**
```ini
cfg_dir=/usr/local/nagios/etc/encore.d
```
Konfigurasi lama di luar `encore.d/` tetap berjalan berdampingan dan tidak akan terganggu.

---

## 2. Tahapan Implementasi

### Tahap M1 — Config Store, `.cfg` Generator & Safe Apply Engine (Backend Go)
- **Target File:** `api/state-gateway/config_store.go`, `api/state-gateway/config_api.go`, `api/state-gateway/main.go`.
- **Flag baru di `encore-state-gateway`:**
  - `-managed-dir /usr/local/nagios/etc/encore.d`
  - `-nagios-bin /usr/local/nagios/bin/nagios`
  - `-nagios-cfg /usr/local/nagios/etc/nagios.cfg`
- **Objek yang dikelola (CRUD penuh + validasi input ketat anti-injection):**
  1. **Hosts:** `name`, `alias`, `address`, `check_command`, `check_interval`, `retry_interval`, `max_check_attempts`, `hostgroups`, `contacts`, `enabled`.
  2. **Services:** `host_name`, `service_description`, `check_command`, `check_interval`, `retry_interval`, `max_check_attempts`, `servicegroups`, `contacts`, `enabled`.
  3. **Commands:** `command_name`, `command_line` (disertai preset bawaan untuk `check_http`, `check_tcp`, `check_ping`, `check_ssh`).
  4. **Contacts & Groups:** `contacts`, `hostgroups`, `servicegroups`.
- **Endpoint REST API baru:**
  - `GET/POST/PUT/DELETE /api/v1/config/hosts`
  - `POST /api/v1/config/hosts/clone` — duplikat host beserta opsi `include_services: true` (otomatis menyalin seluruh service milik host sumber ke host baru).
  - `GET/POST/PUT/DELETE /api/v1/config/services`
  - `POST /api/v1/config/services/clone` — duplikat service ke host yang sama atau ke satu/banyak host tujuan.
  - `GET/POST/PUT/DELETE /api/v1/config/commands`
  - `GET/POST/PUT/DELETE /api/v1/config/contacts`
  - `GET/POST/PUT/DELETE /api/v1/config/groups`
  - `POST /api/v1/config/validate` — generate ke staging & jalankan `nagios -v`, kembalikan output validasi.
  - `POST /api/v1/config/apply` — validasi, buat backup otomatis (simpan 10 versi terakhir), tulis atomik ke `encore.d/`, lalu kirim `RESTART_PROGRAM` ke `nagios.cmd`.
  - `GET /api/v1/config/backups` & `POST /api/v1/config/rollback` — 1-click rollback ke snapshot sebelumnya.

### Tahap M2 — Ekspos Groups, Downtime, Comments & Program Status dari Core C
- **Target File:** `base/query-handler.c`, `api/state-gateway/main.go`.
- **Perubahan Core C (`qh_state()`):**
  - `#state hostgroups` — daftar semua `hostgroup` (`group_name`, `alias`, array nama `members`) langsung dari `hostgroup_list` in-memory.
  - `#state servicegroups` — daftar semua `servicegroup` (`group_name`, `alias`, array `{host_name, description}` `members`) langsung dari `servicegroup_list` in-memory.
  - `#state downtimes` & `#state comments` — daftar *scheduled downtime* & komentar aktif langsung dari memori Nagios (tetap tanpa `status.dat`).
  - Field tambahan di `#state summary`: global program flags (`notifications_enabled`, `execute_service_checks`, `execute_host_checks`, `flap_detection_enabled`, `event_handlers_enabled`).
- **Endpoint API baru di Gateway:**
  - `GET /api/v1/hostgroups` & `GET /api/v1/servicegroups` (sudah dilengkapi agregasi count UP/DOWN/OK/WARN/CRIT per grup).
  - `GET /api/v1/downtimes` & `GET /api/v1/comments`.
  - Perluasan filter di `GET /api/v1/hosts` & `GET /api/v1/services`: `?hostgroup=`, `?servicegroup=`, `?unhandled=1` (problem belum ACK & tidak downtime), `?ack=0|1`, `?downtime=0|1`, `?state_type=0|1` (SOFT/HARD), dan `?sort=severity|name|last_check|duration`.

### Tahap M3 — Dashboard Monitoring UX + Management Console (Embedded UI)
- **Target File:** `api/state-gateway/web/index.html`.
- **A. Peningkatan Tampilan & Navigasi Monitoring (Setara Classic UI, Versi Modern):**
  1. **Tactical Overview Ringkas:** Persentase kesehatan sistem, badge **Unhandled Problems** (problem aktif yang belum di-ACK/downtime), dan status global daemon.
  2. **Tab `Groups` (Hostgroups & Servicegroups):**
     - Tampilan kartu **Overview / Summary** per Hostgroup & Servicegroup lengkap dengan status bar & jumlah UP/DOWN/OK/WARN/CRIT.
     - Klik grup mana saja langsung melompat ke tabel host/service yang sudah terfilter ke grup tersebut.
  3. **Pencarian, Filter & Sorting Canggih:**
     - Shortcut `/` untuk fokus cepat ke search bar (cari nama host, IP, service, atau teks output).
     - Filter kombinasi: **Hostgroup**, **Servicegroup**, **State**, **Unhandled Only**, **In Downtime**, **Acknowledged**, **SOFT/HARD**.
     - **View Switcher:** Mode **Flat Table** vs **Grouped by Host** (service dikelompokkan rapi di bawah setiap host seperti Nagios classic).
     - Klik header kolom untuk **Sorting** (Severity, Nama, Last Check, Durasi State).
  4. **Detail Slide-Over Drawer (Pengganti `extinfo.cgi` tanpa pindah halaman):**
     - Klik baris Host atau Service untuk membuka panel detail: State (`HARD`/`SOFT`), State Duration, Last/Next Check, Latency & Exec Time, Full Output, **Performance Data (`perf_data`) ter-parse rapi**, daftar service milik host, serta tombol aksi lengkap.
- **B. Tab `Manage` (Config Manager) & Kontrol Operasional:**
  1. **Config Manager:**
     - Sub-tab: **Hosts**, **Services**, **Commands**, **Contacts & Groups**, **Backups**.
     - Modal form **Add / Edit / Clone / Delete** yang bersih:
       - **Clone Host** (dengan checkbox *"Clone beserta seluruh service-nya"* — cukup isi nama & IP host baru, seluruh service ikut terduplikasi otomatis).
       - **Clone Service / Command / Contact / Group** (pre-fill seluruh field dari objek sumber, bisa pilih host tujuan lain).
       - *Quick Preset* saat menambah service (pilih *HTTP Check* / *TCP Port* / *Ping* / *SSH* → otomatis mengisi `check_command`).
     - Banner **Pending Changes** di bagian atas dengan tombol **Validate (`nagios -v`)** dan **Apply & Reload**. Jika validasi gagal, error ditampilkan dalam box log yang mudah dibaca.
  2. **Tab `Downtimes` & Modal Aksi:**
     - Tabel *active downtimes* dengan tombol **Cancel Downtime**.
     - Modal interaktif saat klik **Acknowledge** (isi komentar, pilih sticky/notify) dan **Schedule Downtime** (pilih durasi 30m / 1h / 4h / custom & komentar).
     - Tombol toggle **Enable/Disable Checks** & **Enable/Disable Notifications** per host/service maupun secara global di tab **System**.

### Tahap M4 — Proteksi Akses Opsional & Audit Trail
- **Target File:** `api/state-gateway/main.go`.
- **Perubahan:**
  - Tambahkan flag opsional `-auth-user` / `-auth-pass` (HTTP Basic Auth) atau `-api-token` agar jika dashboard dibuka ke jaringan, fitur manajemen tetap terlindungi (jika tidak diset, tetap terbuka seperti sekarang untuk kemudahan pemakaian lokal).
  - Catat setiap aksi manajemen (tambah/edit/hapus host, apply config, rollback, external command) ke file log audit ringan (`encore-audit.log`) dan tampilkan 50 aktivitas terakhir di tab **System**.

---

## 3. Verifikasi & Kriteria Selesai
- Unit test Go untuk validasi input, generator `.cfg`, dan API CRUD (`go test ./...`).
- Uji live end-to-end:
  1. Tambah Host + Service baru lewat UI → klik **Validate & Apply** → Nagios reload sukses → Host & Service baru langsung muncul & ter-check di tab Monitoring.
  2. Masukkan konfigurasi invalid sengaja → klik **Validate & Apply** → sistem menolak perubahan, error tampil di UI, dan Nagios tetap berjalan normal tanpa crash.
  3. Jadwalkan & batalkan Downtime lewat UI → status langsung sinkron real-time.
  4. Uji **Rollback** ke backup sebelumnya → konfigurasi kembali utuh.

---

## 4. Urutan Eksekusi yang Disarankan
1. **Tahap M1** (Backend Config Store + Generator + Safe Validate/Apply) — fondasi utama.
2. **Tahap M3 bagian Config UI** (Form CRUD Host/Service/Command + tombol Validate & Apply) — langsung bisa dipakai manage dari browser.
3. **Tahap M2 + M3 bagian Operasional** (Downtime manager, modal Ack/Downtime, global toggles).
4. **Tahap M4** (Audit log & auth opsional).
