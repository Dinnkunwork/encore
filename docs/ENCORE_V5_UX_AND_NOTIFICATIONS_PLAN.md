# Encore v5 — UX Efficiency, Service Templates, Charts & Email Notifications Plan

Dokumen ini merangkum rencana peningkatan **UI/UX, efisiensi operasional, Service Templates, visualisasi Reports/Charts, dan Built-in Email Notifications** untuk Encore Monitoring Dashboard.

---

## 1. Perbaikan Bug & Friksi UX Prioritas Tinggi

### 1.1 Fix Filter State Bocor antara `Problems` ↔ `Inventory`
- **Masalah saat ini:** Di [monitor.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/monitor.js#L145-L156), `populateStateSelect('problems')` tidak memiliki opsi `"All Problems"` sehingga otomatis memilih `value="2"` (`CRITICAL`). Ketika user kembali ke menu `Inventory`, dropdown mempertahankan `cur = "2"` sehingga `Inventory` ikut terfilter `CRIT` secara otomatis.
- **Solusi:**
  1. Pisahkan state filter per view (`S.invFilter` dan `S.probFilter`: `state`, `unhandled`, `sort`, `search`).
  2. Di mode `Problems`, tambahkan opsi default `<option value="">All Problems</option>` agar menampilkan seluruh problem (CRIT + WARN + UNK) secara default, bukan hanya CRITICAL.
  3. Saat berpindah antara `Problems` dan `Inventory`, muat ulang filter milik view masing-masing tanpa saling menimpa.

### 1.2 Hilangkan Tab `Localhost` yang Tidak Berguna Setelah Adopted
- **Masalah saat ini:** Tab `Localhost` di `Manage` tetap tampil permanen meskipun `localhost.cfg` sudah di-adopt ke Encore Managed Config.
- **Solusi:**
  1. Hapus tab `Localhost` dari bar sub-tab utama `Manage`.
  2. Jika `localhost.cfg` terdeteksi **belum di-adopt** (`STANDALONE`), tampilkan **banner/callout ringkas** di bagian atas `Manage → Objects` dengan tombol **`1-Click Adopt`** dan **`View Raw`**.
  3. Setelah berstatus `ADOPTED`, banner otomatis hilang sehingga navigasi `Manage` menjadi lebih bersih. Akses raw editor tetap tersedia sebagai tombol sekunder di `System → Controls` jika sewaktu-waktu dibutuhkan.

### 1.3 Quick Install Guide NCPA Target di `Guide → NCPA`
- **Masalah saat ini:** Tab `Guide → NCPA` di [guide.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/guide.js#L29-L46) hanya berisi 1 kalimat singkat untuk instalasi di target.
- **Solusi:** Tambahkan sub-tab OS (`Ubuntu/Debian`, `RHEL/Rocky`, `Windows`) lengkap dengan blok perintah siap salin (**Copy button**):
  - Instalasi paket NCPA resmi
  - Konfigurasi `community_string` di `ncpa.cfg`
  - Pembukaan port firewall `5693/tcp` khusus dari IP server Encore (`ufw` / `firewalld`)
  - Perintah `curl` verifikasi koneksi dari server Encore ke target

---

## 2. Efisiensi Menu `Manage`: Search, Grouping & Service Templates

### 2.1 Search, Filter & Accordion Grouping di `Manage → Objects`
- **Masalah saat ini:** Tabel `Hosts` dan `Services` ditumpuk datar ke bawah tanpa search, tanpa filter grup, dan harus scroll panjang saat service bertambah banyak.
- **Solusi:**
  - **Toolbar terpadu** di atas `Manage → Objects`:
    - Search real-time (mencari nama host, IP/address, nama service, atau command)
    - Filter **Hostgroup** dan **Status** (`All / ON / OFF`)
    - Toggle tampilan: **`Grouped by Host` (default)** vs **`Flat Table`** + tombol `Expand All / Collapse All`
  - **Tampilan Grouped by Host (Accordion):**
    - Setiap Host tampil sebagai 1 baris/header ringkas berisi: nama host, IP, hostgroups, badge jumlah service (`8 services`), status `ON/OFF`, dan aksi cepat (`+ Service`, `Apply Template`, `Edit`, `Clone`, `Delete`).
    - Klik baris host untuk membuka/menutup daftar service milik host tersebut saja.

### 2.2 Service Templates (Paket Check Reusable)
- **Kebutuhan:** Menerapkan sekumpulan service check standar (misalnya CPU + RAM + Disk + Procs, atau HTTP + HTTPS + TLS) ke banyak host sekaligus tanpa input atau clone satu per satu.
- **Desain Backend** ([config_store.go](file:///home/dinnkun/projects/encore/api/state-gateway/config_store.go) & [config_api.go](file:///home/dinnkun/projects/encore/api/state-gateway/config_api.go)):
  - Tambah struktur `ServiceTemplate` di `ManagedConfig` (`encore-managed.json`):
    ```json
    {
      "name": "linux-ncpa-basic",
      "description": "CPU, Memory, Disk /, Processes via NCPA",
      "services": [
        { "service_description": "NCPA CPU", "check_command": "check_ncpa!cpu/percent!-w 80 -c 90", "check_interval": 5, "max_check_attempts": 3 },
        { "service_description": "NCPA RAM", "check_command": "check_ncpa!memory/virtual!-w 80 -c 90", "check_interval": 5, "max_check_attempts": 3 },
        { "service_description": "NCPA Disk /", "check_command": "check_ncpa!disk/logical/|/used_percent!-w 80 -c 90", "check_interval": 5, "max_check_attempts": 3 },
        { "service_description": "NCPA Procs", "check_command": "check_ncpa!processes!-w 250 -c 400", "check_interval": 5, "max_check_attempts": 3 }
      ]
    }
    ```
  - Endpoint baru:
    - `GET/POST/DELETE /api/v1/config/templates` — CRUD template
    - `POST /api/v1/config/templates/from-host` — Simpan semua service milik 1 host eksisting menjadi template baru (1-klik)
    - `POST /api/v1/config/templates/apply` — Terapkan 1 template ke 1 atau banyak host sekaligus (otomatis melewati service yang sudah ada agar idempoten)
- **Desain Frontend (`Manage → Templates` + integrasi di Host):**
  - Menyediakan starter templates siap pakai (*Linux NCPA Basic*, *Windows NCPA Basic*, *Web HTTPS Stack*) yang bisa di-clone dan disesuaikan.
  - Saat `+ Add Host` atau klik `Apply Template` pada host mana pun, user cukup mencentang template yang diinginkan → semua service langsung terbuat.

---

## 3. Reports & Charts Per Host / Per Service + Grouping

### 3.1 Filter Granular & Grouping
- **Backend** ([reports.go](file:///home/dinnkun/projects/encore/api/state-gateway/reports.go)):
  - Tambah parameter query `host`, `service`, dan `bucket` (`hour`/`day`) pada `/api/v1/reports/availability`, `/api/v1/reports/events`, dan `/api/v1/reports/export`.
  - Tambah field `timeline` (array bucket per jam/hari: `timestamp`, `ok_pct`, `incidents`) agar frontend dapat menggambar grafik tren SLA & incident.
- **Frontend** ([reports.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/reports.js)):
  - Filter: **Hostgroup** → **Host** → **Service** + **Custom Date Picker** (`From` / `To`) selain preset `24h / 7d / 30d`.
  - Toggle **Group by Host** di tabel SLA: menampilkan ringkasan SLA rata-rata per host, lalu expand untuk melihat detail setiap service-nya.
  - Export **CSV** dan **Printable HTML/PDF** otomatis mengikuti filter host/service yang sedang aktif.

### 3.2 Visual Charts (Ringan, Pure SVG, Zero Dependency)
- **SLA Breakdown Donut Chart:** Menampilkan proporsi `UP/OK`, `WARN`, `CRIT/DOWN`, dan `Downtime` secara visual.
- **Uptime & Incident Trend Bar Chart:** Grafik batang per hari/jam di rentang waktu terpilih (hover menampilkan tooltip tanggal, `% SLA`, dan jumlah incident).
- **Integrasi Drawer:** Tambah tombol **`View SLA Report`** di drawer detail Host/Service (Inventory/Overview) untuk langsung membuka laporan terfilter khusus host/service tersebut.

---

## 4. Built-in Email Notifications (SMTP Tanpa Postfix)

### 4.1 Kenapa Built-in di `encore-state-gateway`?
- Nagios Core tradisional mengharuskan konfigurasi MTA OS (`postfix`/`sendmail`/`msmtp`) dan edit manual template command/contact.
- Dengan engine SMTP bawaan Go (`net/smtp` + `crypto/tls`, 100% stdlib), konfigurasi notifikasi 100% terpusat di Dashboard Encore dan langsung jalan tanpa setup MTA OS.

### 4.2 Arsitektur & Fitur (`api/state-gateway/notify.go`)
- **Konfigurasi tersimpan di** `/usr/local/nagios/etc/encore.d/encore-notify.json` (permission `0600`, password SMTP di-mask di API/UI):
  - `enabled` (ON/OFF)
  - `smtp_host`, `smtp_port` (`587` STARTTLS / `465` SSL/TLS / `25` Plain), `smtp_tls` (`starttls` / `tls` / `none`)
  - `smtp_user`, `smtp_pass`
  - `from_address`, `from_name` (default `Encore Monitor`)
  - `recipients` (daftar email penerima + opsi otomatis ikut mengirim ke email `Contacts` yang terdaftar di Manage)
  - `notify_on`: `down`, `critical`, `warning`, `recovery`
  - `hard_only`: `true` (default — mencegah spam saat `SOFT` flap)
  - `cooldown_min`: jeda minimum antar email untuk objek yang sama (anti-flood)
  - `dashboard_url`: URL opsional agar email menyertakan tombol/link langsung ke dashboard
- **Trigger Real-Time:**
  - Terhubung langsung ke event stream `stateevents` NERD di `StateStore`.
  - Mendeteksi transisi state (misal `OK → CRITICAL (HARD)` atau `CRITICAL → OK (RECOVERY)`), lalu mengirim email secara **asynchronous** (goroutine + queue) agar tidak pernah memblokir update dashboard.
  - Setiap pengiriman (sukses/gagal) dicatat ke **Audit Log** dan **Notification Log**.
- **UI di Dashboard (`Manage → Notifications`):**
  - Form konfigurasi SMTP + pilihan penerima & rule severity.
  - Tombol **`Send Test Email`** dengan pesan diagnostic langsung (sukses / alasan gagal auth/TLS/koneksi).
  - *(Opsional Fase lanjutan)* Tambah channel **Webhook** (Telegram / Slack / Discord) di engine yang sama.

---

## 5. Saran Tambahan Peningkatan UI/UX & Efisiensi Operasional

Berikut rekomendasi tambahan yang berdampak langsung pada kecepatan kerja harian operator:

1. **Bulk Actions (Multi-Select Checkbox):**
   - Di `Inventory` / `Problems`: pilih banyak service sekaligus → **Force Check**, **Acknowledge**, atau **Schedule Downtime** dalam 1 klik.
   - Di `Manage`: pilih banyak host/service → **Enable/Disable**, **Apply Template**, atau **Delete** sekaligus.
2. **Autocomplete Active Commands di Form Service:**
   - Ganti input teks kosong pada `Check Command` dengan combobox/autocomplete dari `/api/v1/catalog/commands` + preview format argumen (`contoh: check_ncpa!cpu/percent!-w 80 -c 90`), sehingga mencegah salah ketik / error `command not defined`.
3. **Sticky "Pending Changes" Bar di Topbar:**
   - Saat ada perubahan config yang belum di-apply, tampilkan banner tipis konsisten di bagian atas halaman dengan tombol **`Validate`** & **`Apply & Reload`** agar tidak lupa apply.
4. **Cross-Link Cepat antar Menu (Zero Friction):**
   - Dari Drawer detail Host/Service di `Inventory`, tambahkan tombol cepat **`Edit Config`**, **`+ Add Service`**, dan **`View SLA Report`**.
5. **Auto-Pause Refresh Saat Interaksi:**
   - Otomatis menunda auto-refresh 3 detik ketika modal/drawer terbuka atau user sedang mengetik/memilih checkbox agar baris tabel tidak loncat.
6. **Quick Jump Palette (`Ctrl+K`):**
   - Shortcut untuk langsung melompat ke host, service, atau tab mana pun dari keyboard.

---

## 6. Urutan Eksekusi yang Disarankan

| Tahap | Cakupan | Estimasi Risiko |
|---|---|---|
| **Tahap 1 — UX Quick Wins** | Fix filter `Problems ↔ Inventory`, sembunyikan tab `Localhost` setelah adopted, tambah Quick Install Guide NCPA, autocomplete command, sticky pending bar | Sangat rendah |
| **Tahap 2 — Manage & Templates** | Search + Accordion Grouping di `Manage → Objects`, CRUD `Service Templates`, `Save from Host`, `Apply Template` ke 1/banyak host | Rendah |
| **Tahap 3 — Reports & Charts** | Filter per Host/Service + Custom Date, Group by Host di SLA, SVG Donut & Trend Bar Chart, link `View SLA Report` dari Drawer | Rendah |
| **Tahap 4 — Built-in Email (SMTP)** | Engine `notify.go` (STARTTLS/TLS, HARD-only, Recovery, Cooldown, Async queue), UI `Manage → Notifications`, tombol `Send Test Email` | Rendah–Sedang |
| **Tahap 5 — Power-User UX (Opsional)** | Bulk Actions (multi-select), `Ctrl+K` Quick Jump, Webhook (Telegram/Slack/Discord) | Rendah |
