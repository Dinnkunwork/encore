# Rencana Tahapan: Encore Dashboard v2 (Sidebar Layout, Brand Assets & Localhost Management)

Dokumen ini merinci rencana upgrade **Encore Web Dashboard** (`api/state-gateway`) menjadi konsol monitoring & manajemen berkelas produksi dengan:
1. **Manajemen `localhost.cfg`** langsung dari dashboard (tanpa edit file manual di server).
2. **Navigasi Sidebar Kiri** yang terstruktur dengan halaman **Overview** yang kaya informasi (tidak terlalu simpel).
3. **Integrasi Asset Kit** dari `assets/` secara relevan, bersih, dan ter-embed di binary Go.

---

## 1. Pemetaan Asset dari `assets/` (Hanya yang Relevan)

File `:Zone.Identifier`, `preview.html`, dan gambar berukuran besar yang tidak terpakai (`logo-1024.png`, `og-image-1200x630.png`) **tidak** ikut di-embed agar ukuran binary Go tetap ringan. Asset yang di-embed ke `api/state-gateway/web/assets/`:

| Folder Asset | File yang Dipakai | Penggunaan di Dashboard |
| :--- | :--- | :--- |
| `favicon/` | `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png` | Browser tab icon & PWA/bookmark icon (`/favicon.ico`, `/assets/favicon/...`) |
| `logo/` | `logo.svg` | Brand logo di header Sidebar kiri |
| `icons/` | `dashboard.svg`, `server.svg`, `cpu.svg`, `alert.svg`, `network.svg`, `bell.svg`, `settings.svg`, `user.svg`, `log.svg`, `search.svg`, `cloud.svg`, `database.svg` | Ikon menu Sidebar, search bar, dan kategori preset/sub-tab manajemen |
| `status/` | `status-ok.svg`, `status-warn.svg`, `status-critical.svg`, `status-offline.svg`, `status-info.svg` | Indikator visual status pada KPI cards, tabel Host/Service, Detail Drawer, dan Group cards |

Seluruh folder `web/` akan di-embed lewat `//go:embed web` di Go dan dilayani pada `/assets/...` dengan header `Cache-Control: public, max-age=86400`.

---

## 2. Manajemen `localhost.cfg` dari Dashboard

Saat ini `localhost` didefinisikan di `/usr/local/nagios/etc/objects/localhost.cfg` (di luar `encore.d/`), sehingga belum muncul di Config Manager.

### Pendekatan Aman (2 Mode)
1. **Mode 1 — Adopt `localhost.cfg` ke Managed Config (Rekomendasi, 1-Click):**
   - Flag baru di `encore-state-gateway`: `-localhost-cfg /usr/local/nagios/etc/objects/localhost.cfg`.
   - Endpoint `POST /api/v1/config/localhost/adopt`:
     - Mem-parse blok `define host`, `define hostgroup`, dan `define service` dari `localhost.cfg`.
     - Memasukkan `localhost`, hostgroup `linux-servers`, dan seluruh service-nya (`PING`, `Root Partition`, `Current Users`, `Total Processes`, `Current Load`, `Swap Usage`, `SSH`, `HTTP`) ke `encore-managed.json`.
     - Menyimpan backup asli `localhost.cfg` ke `encore.d/backups/localhost.cfg.orig`, lalu mengosongkan `localhost.cfg` dengan komentar header penanda (sehingga `nagios.cfg` tidak perlu diubah dan tidak terjadi *duplicate object error* saat `nagios -v`).
     - Menjalankan `ValidateAndApply(true)` otomatis.
   - Setelah di-adopt, `localhost` & semua service-nya 100% bisa di-edit, di-toggle enable/disable, di-clone, ditambah/hapus service-nya langsung lewat form UI!
2. **Mode 2 — Direct Localhost Editor (Sebelum/Tanpa Adopt):**
   - Endpoint `GET /api/v1/config/localhost` & `PUT /api/v1/config/localhost`:
     - Memungkinkan melihat status file `localhost.cfg` (apakah sudah di-adopt atau masih standalone), melihat daftar objek di dalamnya, dan mengedit raw `.cfg` secara aman dengan validasi `nagios -v` otomatis sebelum disimpan + backup otomatis jika belum ingin meng-adopt.

---

## 3. Arsitektur UI Baru: Left Sidebar + Rich Monitoring Console

### A. Layout Utama (Fixed Collapsible Left Sidebar + Top Context Bar)
- **Sidebar Kiri (`250px`, bisa collapse ke `68px` icon-only & responsif drawer di mobile):**
  - **Brand Header:** `logo.svg` + title **Encore** + subtitle *Monitoring Console*.
  - **Grup `MONITORING`:**
    1. **Overview** (`dashboard.svg`) — *Landing page utama* (bukan langsung tabel polos).
    2. **Hosts** (`server.svg`) — Daftar host + hostgroup filter + Detail Drawer.
    3. **Services** (`cpu.svg`) — Flat Table & Grouped by Host + filter canggih + Detail Drawer.
    4. **Problems** (`alert.svg`) — Triage view + **badge counter merah** live di sidebar.
    5. **Groups** (`network.svg`) — Kartu Hostgroups & Servicegroups Overview.
    6. **Downtimes** (`bell.svg`) — Daftar active/scheduled downtime + tombol Cancel.
  - **Grup `MANAGEMENT`:**
    7. **Localhost** (`server.svg`) — Dedicated Localhost Manager (1-click Adopt + Edit/Clone service lokal + Raw Editor fallback).
    8. **Hosts & Services** (`cloud.svg`) — CRUD + **Clone Host (with services)** + **Clone Service** + Preset Check.
    9. **Commands & Groups** (`database.svg`) — CRUD Commands, Hostgroups, Servicegroups.
    10. **Contacts** (`user.svg`) — CRUD Contacts.
    11. **System & Audit** (`log.svg`) — Global Program Toggles, Config Backups (1-click Rollback), Audit Log, & Live Validation Console.
  - **Sidebar Footer:**
    - Status koneksi live (`status-ok.svg` / `status-critical.svg`) + NERD events counter.
    - Tombol **Apply Changes** permanen yang menyala amber saat ada `pending_changes`.

### B. Halaman `Overview` yang Kaya & Informatif (Tidak Terlalu Simpel)
- **Baris 1 — 4 KPI Stat Cards** (dengan ikon `status/*.svg`, angka besar, persentase, & sub-breakdown):
  - **Host Health** (UP / DOWN / UNREACH + % sehat)
  - **Service Health** (OK / WARN / CRIT / UNK + % sehat)
  - **Unhandled Problems** (Host + Service yang belum di-ACK/Downtime — klik langsung lompat ke triage)
  - **System Engine** (PID, Active Checks ON/OFF, Notifications ON/OFF, NERD events/s)
- **Baris 2 — 2-Column Operational Split:**
  - **Kiri (60%): Active & Unhandled Problems Feed** — Menampilkan hingga 10 problem paling kritis lengkap dengan status icon, host/service, durasi, output, dan tombol cepat **↻ Force Check** & **✓ ACK**.
  - **Kanan (40%): Hostgroup Health Summary + Recent Audit Activity** — Visual progress bar kesehatan per Hostgroup + 5 aktivitas manajemen terakhir.

---

## 4. Urutan Implementasi

1. **Tahap V2-1 — Integrasi Assets & Static Serving (Go):**
   - Salin asset relevan dari `assets/` ke `api/state-gateway/web/assets/`.
   - Update `//go:embed web` dan routing `/assets/` + `/favicon.ico` di `api/state-gateway/main.go`.
2. **Tahap V2-2 — Backend Localhost Parser, Adopt & Raw Editor (Go):**
   - Tambah `api/state-gateway/localhost_cfg.go` (parser Nagios `.cfg`, adopt ke `encore-managed.json`, direct safe edit dengan `nagios -v`, unit test).
   - Wire flag `-localhost-cfg` dan endpoint `/api/v1/config/localhost` + `/api/v1/config/localhost/adopt`.
3. **Tahap V2-3 — Redesign Dashboard v2 (Sidebar Kiri + Halaman Overview + Localhost UI):**
   - Bangun ulang `api/state-gateway/web/index.html` dengan Sidebar Kiri collapsible, Top Context Bar, halaman Overview kaya data, pemakaian semua SVG asset secara konsisten, dan halaman **Localhost Management**.
4. **Tahap V2-4 — Verifikasi End-to-End & Update Docs:**
   - Jalankan `go test ./...`, uji live adopt `localhost.cfg` + `nagios -v` + reload, serta perbarui `docs/DEPLOYMENT_GUIDE.md` dengan flag `-localhost-cfg`.
