# Rencana Konkrit: Menu User Guide, Command/Plugin Catalog & Custom Script Manager

Dokumen ini merinci rencana untuk menambahkan **Menu `User Guide` & Pusat Dokumentasi Interaktif** langsung di dalam **Encore Dashboard** (`api/state-gateway`), sehingga operasional, penambahan host/service/command, lokasi penyimpanan file, hingga pembuatan custom check script semuanya terpusat di satu tempat.

---

## 1. Penempatan di Sidebar Kiri

Menambahkan section baru di bagian bawah navigasi Sidebar Kiri:
- **Section `DOCS & SCRIPTS`**
  - **User Guide** (`/assets/icons/log.svg`) — Panduan interaktif 4 tab (Operasional, Manajemen Config, Katalog Command & Plugin Live, Arsitektur & Lokasi File).
  - **Custom Scripts** (`/assets/icons/settings.svg`) — *(Terintegrasi di Management / Docs)* untuk melihat, membuat, mengedit, dan menguji custom script check langsung dari dashboard tanpa SSH.

---

## 2. Desain 4 Tab di Menu `User Guide`

### Tab 1 — Operasional & Monitoring Harian
- **Arti Status & Badge:** Tabel visual memakai ikon `status/*.svg` (`UP/DOWN/UNREACH`, `OK/WARN/CRIT/UNK`, `PENDING`, serta tag `SOFT`, `HARD`, `ACK`, `DT`, `FLAP`).
- **Alur Triage Masalah (Step-by-Step):**
  1. Pantau **Overview** → cek angka **Unhandled Problems**.
  2. Klik baris problem untuk membuka **Detail Drawer** (lihat output lengkap & *Performance Data*).
  3. Lakukan **↻ Force Check** untuk memastikan kondisi real-time.
  4. Klik **✓ Acknowledge** (tulis alasan agar tidak menumpuk di *Unhandled*) atau **⏱ Schedule Downtime** bila sedang maintenance.
- **Tips Produktivitas:** Shortcut `/` untuk quick search, `Esc` untuk tutup modal/drawer, mode **Grouped by Host**, dan filter **Hostgroup / Servicegroup**.

### Tab 2 — SOP Manajemen Konfigurasi (Host, Service, Clone & Reload)
- **Panduan Langkah demi Langkah:**
  1. **Menambah Host Baru:** `Management → Hosts & Services → + Add Host` → isi Name, IP, Check Command (`check-host-alive`), Hostgroup.
  2. **Menambah Service Baru:** `+ Add Service` → pilih Host → gunakan **Quick Preset** (`HTTP`, `TCP`, `Ping`, `SSH`, `Disk`) atau ketik format `nama_command!ARG1!ARG2`.
  3. **Cloning Cepat:** Klik **Clone** pada Host (centang *"Clone all services"* untuk menyalin seluruh service sekaligus) atau **Clone** pada Service/Command.
  4. **Adopt `localhost.cfg`:** `Management → Localhost Config → 1-Click Adopt` agar `localhost` dan 8 service bawaannya bisa dikelola lewat form.
  5. **Siklus Validasi & Apply Aman:** Setiap perubahan masuk status **Pending Changes** → klik **Validate (`nagios -v`)** → klik **Apply & Reload** (otomatis membuat backup sebelum reload via `RESTART_PROGRAM`).
  6. **Rollback Darurat:** `System & Audit → Config Backups → Rollback` untuk kembali ke versi sebelumnya dalam 1 klik.

### Tab 3 — Katalog Command & Plugin Live (Dinamis dari Server!)
Bukan dokumentasi statis — gateway membaca langsung dari server melalui endpoint baru:
- **`GET /api/v1/catalog/commands`:**
  - Menggabungkan **Built-in Commands** (di-parse dari `/usr/local/nagios/etc/objects/commands.cfg`) + **Managed Commands** (dari `encore-managed.json`) + tanda **In-Process Fast-Path** (`check_tcp`, `check_http`, `check_dummy` yang dijalankan `encore-go-worker` tanpa `fork/exec`).
  - Menampilkan tabel pencarian lengkap: **Nama Command**, **Sumber** (`Built-in` / `Managed` / `Go Fast-Path`), **Command Line**, **Contoh Penggunaan** (mis. `check_tcp!443`, `check_http!-p 8080 -u /health`, `check_local_disk!20%!10%!/`), dan tombol **Copy**.
- **`GET /api/v1/catalog/plugins`:**
  - Memindai direktori plugin aktif (membaca `$USER1$` dari `/usr/local/nagios/etc/resource.cfg`, plus `/usr/local/nagios/libexec` & `/usr/local/nagios/etc/encore.d/scripts`).
  - Menampilkan daftar seluruh binary & script yang tersedia di server beserta path absolutnya.

### Tab 4 — Lokasi File, Macro & Cara Membuat Custom Script
- **Peta Lokasi File Aktual (Dinamis sesuai flag gateway):**
  | Komponen | Lokasi di Server | Keterangan |
  | :--- | :--- | :--- |
  | Managed Config JSON | `/usr/local/nagios/etc/encore.d/encore-managed.json` | Source of truth objek dari dashboard |
  | Generated `.cfg` | `/usr/local/nagios/etc/encore.d/encore-*.cfg` | File `.cfg` hasil generate otomatis |
  | Custom Scripts | `/usr/local/nagios/etc/encore.d/scripts/` | Tempat simpan script check custom dari dashboard |
  | Config Backups | `/usr/local/nagios/etc/encore.d/backups/` | 10 snapshot terakhir untuk 1-click rollback |
  | Audit Log | `/usr/local/nagios/etc/encore.d/encore-audit.log` | Riwayat semua aksi manajemen |
  | Built-in Commands | `/usr/local/nagios/etc/objects/commands.cfg` | Command bawaan Nagios |
  | Plugin Binaries (`$USER1$`) | `/usr/lib/nagios/plugins` (via `resource.cfg`) | Paket `monitoring-plugins` |
  | State Retention | `/usr/local/nagios/var/retention.dat` | Persistensi status saat restart |
- **Referensi Macro Penting:** `$HOSTADDRESS$`, `$HOSTNAME$`, `$SERVICEDESC$`, `$ARG1$`..`$ARGn$`, `$USER1$`.
- **Standar Custom Script Nagios:**
  - Exit code: `0 = OK`, `1 = WARNING`, `2 = CRITICAL`, `3 = UNKNOWN`.
  - Format stdout: `<STATUS> - <pesan singkat> | <metric>=<val>;<warn>;<crit>;<min>;<max>`.
  - Template siap pakai (Bash & Python 3) yang bisa langsung disalin atau dibuat lewat **Custom Script Manager**.

---

## 3. Custom Script Manager (Terpusat di Dashboard — Tanpa SSH)

Agar penambahan script baru juga 100% bisa dilakukan dari dashboard:
- **Direktori penyimpanan:** `<managed-dir>/scripts/` (mis. `/usr/local/nagios/etc/encore.d/scripts/`), otomatis dibuat & dikelola oleh user `nagios`.
- **Endpoint API baru (`api/state-gateway/scripts_api.go`):**
  - `GET /api/v1/scripts` — daftar semua custom script di `<managed-dir>/scripts/` (nama, ukuran, waktu ubah, path absolut).
  - `GET /api/v1/scripts/content?name=...` — baca isi script.
  - `POST /api/v1/scripts` — buat/edit script (validasi nama file ketat `^[a-zA-Z0-9._-]+$`, otomatis `chmod 0755`, simpan atomik, catat ke audit log).
  - `DELETE /api/v1/scripts?name=...` — hapus script.
  - `POST /api/v1/scripts/test` — jalankan dry-run test script dengan argumen opsional (timeout 10 detik) dan tampilkan **Exit Code + Stdout + Stderr** langsung di UI!
- **Integrasi 1-Klik ke Command:** Tombol **"Register as Command"** di setiap script otomatis membuka form *Add Command* dengan `command_line` terisi `/usr/local/nagios/etc/encore.d/scripts/<nama_script> $HOSTADDRESS$ $ARG1$`.

---

## 4. Urutan Eksekusi Implementasi

1. **Tahap UG-1 — Backend Catalog & Scripts Engine (Go):**
   - Buat `api/state-gateway/catalog.go` (`GET /api/v1/catalog/commands`, `GET /api/v1/catalog/plugins`, `GET /api/v1/catalog/paths` — mem-parse `commands.cfg` & `resource.cfg`).
   - Buat `api/state-gateway/scripts_api.go` (CRUD + Test Run custom script di `<managed-dir>/scripts/` + unit tests).
   - Wire flag opsional `-commands-cfg` (default `/usr/local/nagios/etc/objects/commands.cfg`) & `-resource-cfg` (default `/usr/local/nagios/etc/resource.cfg`) di `main.go`.
2. **Tahap UG-2 — UI Menu `User Guide` & `Custom Scripts` (`web/index.html`):**
   - Tambah menu **User Guide** & **Custom Scripts** di Sidebar Kiri.
   - Implementasikan 4 tab interaktif User Guide + search di katalog command/plugin + tombol Copy + editor & test runner Custom Scripts.
3. **Tahap UG-3 — Verifikasi Unit Test & Live E2E:**
   - Jalankan `go test -v ./...` + live test katalog command, pembuatan custom script, test-run script (exit code & stdout), dan register sebagai command.

---

## 5. Peningkatan UI Affordance (Membedakan Tombol/Interaktif vs Teks Biasa)

Agar pengguna langsung tahu mana elemen yang bisa diklik/diubah dan mana teks informatif biasa:
- **Tombol (`.btn`, `.icon-btn`):**
  - Tambahkan elevasi lembut (`box-shadow`), border yang lebih tegas, efek hover nyata (`translateY(-1px)` + border `--accent`), dan efek tekan (`scale(0.98)`).
  - Bedakan jelas 3 tingkat tombol: **Primary** (solid biru), **Secondary** (background terisi ringan + border tegas), dan **Danger** (tint merah + border merah).
- **Kartu & Baris Tabel yang Bisa Diklik:**
  - KPI Cards & Group Cards diberi indikator klik (`View →` / chevron `›`) dan hover ring `--accent`.
  - Baris tabel yang membuka Detail Drawer diberi aksen *left-border highlight* saat hover (`box-shadow: inset 3px 0 0 var(--accent)`).
- **Teks Read-Only & Status Badge:**
  - Tetap flat tanpa shadow/hover tombol (`cursor: default`), sehingga kontras jelas terhadap elemen interaktif.

---

## 6. Integrasi Remote Check dengan NCPA (Nagios Cross-Platform Agent)

NCPA adalah agent resmi Nagios untuk monitoring server remote (Linux/Windows/macOS) melalui **HTTPS REST API di port `5693`** menggunakan token (`community_string`).

### A. Fast-Path In-Process `check_ncpa.py` di `worker/go-worker`
- Karena NCPA menggunakan HTTPS JSON API standar (`/api/<metric>?token=...&warning=...&critical=...&check=1`), kita menambahkan handler **`check_ncpa.py`** langsung di `worker/go-worker/main.go` (mendukung `-H`, `-P`, `-t`, `-M`, `-w`, `-c`, `-u`, `-q`, `-T`).
- **Keuntungan:** Remote check NCPA (CPU, RAM, Disk, Processes, Services) dieksekusi **in-process di Go** tanpa `fork()` Python per check (jauh lebih hemat CPU/RAM), dan otomatis fallback ke binary/script `check_ncpa.py` bila ada argumen khusus.

### B. Dukungan NCPA Terpusat di Dashboard
1. **Quick Presets NCPA** di modal `+ Add Service`:
   - `NCPA CPU` (`check_ncpa!<TOKEN>!cpu/percent!-w 80 -c 90`)
   - `NCPA Memory` (`check_ncpa!<TOKEN>!memory/virtual!-w 80 -c 90`)
   - `NCPA Disk /` (`check_ncpa!<TOKEN>!disk/logical/|/used_percent!-w 80 -c 90`)
   - `NCPA Processes` (`check_ncpa!<TOKEN>!processes!-w 250 -c 400`)
2. **Panduan Lengkap NCPA di Tab `User Guide`:**
   - Langkah install NCPA di target server (Linux & Windows), konfigurasi token di `ncpa.cfg`, pembukaan firewall port `5693/tcp`, registrasi command `check_ncpa`, dan contoh penggunaan di dashboard.
