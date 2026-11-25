# Encore v6 — Visual Overview Map, Config Diff/Discard, Modern UX & Complete Guide Plan

Dokumen ini merangkum rencana pengembangan **Encore v6** untuk meningkatkan kepadatan informasi di `Overview`, keamanan & kejelasan alur perubahan konfigurasi (*diff highlight & discard*), interaksi modern (*custom confirm dialogs*, *bulk delete*), kerapihan sidebar/mobile, sentuhan visual & animasi ringan, serta **User Guide komprehensif** terpusat di dashboard.

---

## 1. Overview: Visual Host/Service Map & Fleet Charts

- **Tujuan:** Membuat halaman `Overview` langsung menjawab *"apakah infrastruktur sehat, mana yang bermasalah, dan bagaimana tren 24 jam terakhir?"* tanpa harus membuka banyak menu.
- **Komponen Baru (100% Pure SVG, zero external library, otomatis ikut Light/Dark theme):**
  1. **Interactive Fleet Health Map (Panel Utama di Overview):**
     - Menampilkan seluruh host dalam bentuk **Status Tile Grid** yang rapat dan informatif:
       - Warna border/dot menunjukkan status Host (`UP`, `DOWN`, `UNREACH`, `PENDING`).
       - Mini progress bar & counter di tiap tile menunjukkan kesehatan Service di dalam host tersebut (`OK / WARN / CRIT`).
       - Hover menampilkan tooltip ringkas (IP, status, jumlah service bermasalah); klik tile langsung membuka **Host Detail Drawer** atau filter ke host tersebut.
     - Dilengkapi tombol toggle cepat: **`Health Grid`** (ideal untuk banyak host) dan **`Topology View`** (diagram SVG *Encore Engine → Hostgroups → Host Nodes*).
  2. **Fleet State Distribution & 24h Trend (Mini-Charts Card):**
     - **Service Health Donut SVG** (proporsi `OK`, `WARN`, `CRIT`, `UNK`, `PEND`).
     - **24h Uptime Sparkline / Mini-Bar** (diambil dari `/api/v1/reports/availability` dengan *client-side cache* 60 detik agar tidak membebani polling 3 detik).

---

## 2. Bulk Delete Host & Service + Modern Confirmation Dialog

### 2.1 Bulk Actions untuk Services (di `Manage → Objects`)
- **Backend** ([config_store.go](file:///home/dinnkun/projects/encore/api/state-gateway/config_store.go), [config_api.go](file:///home/dinnkun/projects/encore/api/state-gateway/config_api.go)):
  - Tambah `BulkServicesAction(action string, items []ServiceRef)` dan endpoint `POST /api/v1/config/services/bulk` mendukung `enable`, `disable`, dan `delete` untuk banyak service sekaligus.
- **Frontend** ([manage.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/manage.js)):
  - Checkbox multi-select pada baris Service (baik di dalam accordion tiap host maupun di Flat view) + checkbox *Select All* per host.
  - Bulk Action Bar muncul dinamis menampilkan jumlah host &/atau service terpilih dengan aksi **Enable**, **Disable**, **Apply Template**, dan **Delete Selected**.

### 2.2 Modern Smooth Confirmation & Input Dialog (Hapus `confirm()` & `prompt()` Browser)
- **Masalah saat ini:** Penghapusan, rollback, adopt, dan bulk ACK/Downtime masih memakai `window.confirm()` / `window.prompt()` bawaan browser yang kaku.
- **Solusi** ([core.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/core.js), [app.css](file:///home/dinnkun/projects/encore/api/state-gateway/web/css/app.css)):
  - Buat helper reusable `encoreConfirm({ title, message, items, confirmText, danger })` berbasis Promise:
    - Animasi masuk smooth (`scale(0.96) -> scale(1)` + `opacity`, 150ms) dengan backdrop blur halus.
    - Ikon status SVG di header dialog (warning/trash merah untuk aksi destruktif, info biru untuk konfirmasi standar).
    - Daftar preview item yang terdampak (misal: *"Menghapus 2 host dan 9 service terkait"* dengan chip nama item).
    - Tombol jelas dengan kontras tinggi (`Cancel` vs `Delete 2 Hosts`), mendukung tombol `Esc` untuk batal.
  - Ganti seluruh `prompt()` pada Bulk Acknowledge & Bulk Downtime di [monitor.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/monitor.js) menjadi modal form modern.

---

## 3. Cancel / Discard Pending Changes & Visual Diff Highlight

- **Tujuan:** Operator selalu tahu **objek mana yang sedang dalam status draft/diubah**, apa saja perubahannya, dan dapat membatalkan seluruh perubahan yang belum di-apply dengan 1 klik.
- **Backend** ([config_store.go](file:///home/dinnkun/projects/encore/api/state-gateway/config_store.go), [config_api.go](file:///home/dinnkun/projects/encore/api/state-gateway/config_api.go)):
  - Simpan baseline konfigurasi aktif terakhir (`committedCfg`, dipersist ke `encore-committed.json` setiap kali `Apply & Reload` sukses atau saat startup pertama kali).
  - Tambah endpoint:
    - `GET /api/v1/config/diff` — mengembalikan diff terstruktur per kategori (`hosts`, `services`, `commands`, `contacts`, `hostgroups`, `servicegroups`) berisi status `added`, `modified` (plus daftar field yang berubah), dan `deleted`, beserta `total_changes`.
    - `POST /api/v1/config/discard` — mengembalikan `cs.cfg` dan `encore-managed.json` persis ke `committedCfg`, mereset `pendingChanges = false`, dan mencatatnya ke Audit Log.
- **Frontend** ([manage.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/manage.js), [index.html](file:///home/dinnkun/projects/encore/api/state-gateway/web/index.html)):
  - **Highlight Visual Langsung di `Manage`:**
    - Objek baru: garis tepi kiri hijau + badge **`NEW`**.
    - Objek diubah: garis tepi kiri kuning/amber + badge **`MODIFIED`** (tooltip menampilkan field yang berubah, mis. `address, check_interval`).
    - Objek yang dihapus (belum di-apply): tampil di modal **`Review Changes`** dengan badge **`DELETED`**.
  - **Sticky Pending Banner Diperkaya:**
    - Menampilkan ringkasan angka perubahan (`+2 added • 1 modified • 1 deleted`).
    - Tombol lengkap: **`Review Changes`**, **`Discard Changes`** (pakai modern confirm dialog), **`Validate`**, dan **`Apply & Reload`**.

---

## 4. Kejelasan `Save (Instant)` vs `Save Draft (Needs Apply & Reload)`

- **Masalah saat ini:** Operator bisa bingung apakah tombol `Save` di `Notifications`, `Templates`, atau `Scripts` butuh `Apply & Reload` seperti `Hosts/Services`.
- **Solusi Konsisten di Seluruh UI:**
  - **Kategori 1 — Instant Save (Langsung aktif di Gateway, tanpa reload Nagios):**
    - `Manage → Notifications` (SMTP & Webhook), `Manage → Templates`, `Manage → Commands (Custom Scripts)`.
    - Tampilkan pill hijau **`Instant Save — aktif langsung tanpa Reload`** dan label tombol **`Save & Activate`**.
  - **Kategori 2 — Staged Nagios Config (Draft, butuh `Apply & Reload`):**
    - `Hosts`, `Services`, `Commands`, `Hostgroups`, `Servicegroups`, `Contacts`.
    - Label tombol di modal: **`Save Draft`** + info kecil *"Perlu klik Apply & Reload agar aktif di Nagios"*.
  - **Kategori 3 — Auto-Reload (`Secrets / resource.cfg`):**
    - Pill biru **`Auto-Reload Nagios`** + tombol **`Save & Reload`**.

---

## 5. Perapihan Sidebar Kiri & Mobile Responsive Cleanup

- **Sidebar Kiri** ([index.html](file:///home/dinnkun/projects/encore/api/state-gateway/web/index.html), [app.css](file:///home/dinnkun/projects/encore/api/state-gateway/web/css/app.css)):
  - Active indicator yang lebih rapi (garis aksen vertikal kiri + highlight lembut), spacing section yang seimbang, dan ikon alignment presisi saat *expanded* maupun *collapsed*.
  - Hapus tombol duplikat `Apply Pending Changes` di footer sidebar (sudah diwakili Sticky Pending Banner di atas) dan ganti dengan **dot/counter badge kecil** di menu `Manage` saat ada pending changes agar sidebar bersih.
  - Footer sidebar fokus pada indikator status koneksi dengan **live breathing pulse dot** yang elegan.
- **Mobile Cleanup (`<= 820px`):**
  - Sembunyikan kontrol desktop-only di layar kecil (`sb-toggle` collapse sidebar desktop, tombol `⌘K` keyboard shortcut, teks metadata panjang yang terpotong).
  - Tambahkan **mobile sidebar backdrop** sehingga mengetuk area luar sidebar langsung menutup drawer menu.
  - Rapikan susunan topbar, sub-tabs (horizontal scroll halus tanpa memecah layout), dan ukuran tombol sentuh.

---

## 6. Art Kreatif Bertema Sama & Micro-Animations Ringan

- **Inline SVG Illustrations (tema konsisten dengan logo & palet Encore, adaptif Light/Dark mode, < 2 KB masing-masing):**
  - **All-Clear Radar Illustration:** Tampil pada panel *Unhandled Problems* ketika 0 masalah (menggantikan teks polos membosankan).
  - **Empty-State Illustrations:** Ilustrasi ringkas bertema server/blueprint/envelope saat tabel Hosts, Templates, Notifications Log, atau Reports kosong.
  - **Brand Accent Pattern:** Aksen grid/glow ultra-halus di header Overview dan kartu KPI.
- **Micro-Animations Ringan (Pure CSS `transform` & `opacity` saja, 0% beban JS/CPU):**
  - Live status breathing dot (`@keyframes pulse-dot`).
  - Smooth reveal pada modal, drawer, confirm dialog, toast, dan perpindahan section (`140ms–180ms`).
  - Respect `@media (prefers-reduced-motion: reduce)` agar aksesibel untuk semua perangkat.

---

## 7. User Guide Komprehensif & Interaktif (`Guide`)

Memperluas [guide.js](file:///home/dinnkun/projects/encore/api/state-gateway/web/js/guide.js) menjadi buku panduan lengkap di dalam dashboard dengan **kotak pencarian internal Guide** dan 6 tab terstruktur:

1. **`Overview & Workflow`**
   - Cara kerja Encore (Nagios Core + Go Fast Worker + State Gateway), alur kerja harian operator, perbedaan **Instant Save vs Draft/Apply vs Auto-Reload**, penjelasan seluruh status badge (`UP/OK/WARN/CRIT/UNK/PEND`) & flags (`ACK/DT/SOFT/FLAP`), serta daftar **Keyboard Shortcuts** (`Ctrl+K`, `/`, `Esc`).
2. **`Menu & Feature Guide` (Detail Lengkap per Menu)**
   - Panduan langkah demi langkah untuk setiap menu:
     - **Overview:** Cara baca KPI, Fleet Health Map, Topology View, dan 24h Trend.
     - **Inventory & Problems:** Cara filter, Group by Host, Drawer detail & Performance Data, serta **Bulk Actions** (Force Check / ACK / Downtime massal).
     - **Reports & Charts:** Cara filter per Hostgroup/Host/Service, Custom Date, membaca Donut/Trend/MTTR, dan Export CSV/PDF.
     - **Manage (Objects, Templates, Commands, Scripts, Groups, Secrets):** Cara tambah/clone host & service, menggunakan *Service Templates*, menulis & test *Custom Script*, *Review Diff / Discard Changes*, hingga *Validate & Apply*.
     - **System:** Global engine controls, auto-backup & 1-click Rollback, Audit Log.
   - Setiap bagian dilengkapi tombol cepat **`Open Menu ›`** agar user bisa langsung mempraktikkannya.
3. **`NCPA & Remote Monitoring`**
   - Quick Install Target (`Ubuntu/Debian`, `RHEL/Rocky`, `Windows`) dengan tombol Copy, konfigurasi token `$USER2$`, penggunaan template `linux-ncpa-basic` / `windows-ncpa-basic`, contoh metrik NCPA populer (CPU, RAM, Disk, Interface, Service Windows/Linux), dan checklist troubleshooting port `5693`.
4. **`Notifications (Email & Webhook)`**
   - Panduan lengkap setup SMTP (contoh port `587` STARTTLS vs `465` SSL/TLS, Gmail App Password, Office365, SMTP relay internal).
   - Panduan setup **Telegram Bot** (`@BotFather` + cara ambil `chat_id`), **Slack Incoming Webhook**, **Discord Webhook**, serta penjelasan `HARD Only`, `Recovery`, dan `Cooldown`.
5. **`Command & Plugin Catalog`**
   - Katalog live seluruh command aktif (ditandai `Go Fast` vs standar) + daftar plugin di `$USER1$` + contoh argumen siap salin.
6. **`Paths & Troubleshooting`**
   - Tabel lengkap lokasi file di server + panduan cepat mengatasi masalah umum (*command not defined*, *validation error*, *connection refused*, *rollback backup*, *update binary aman*).

---

## 8. Urutan Implementasi & Verifikasi

| Tahap | Cakupan | File Utama |
|---|---|---|
| **Tahap 1 — Backend Diff, Discard & Bulk Services** | `committedCfg` baseline, `GET /api/v1/config/diff`, `POST /api/v1/config/discard`, `POST /api/v1/config/services/bulk` + unit tests | `config_store.go`, `config_api.go`, `main_test.go` |
| **Tahap 2 — Modern UI Foundation, Sidebar & Mobile** | `encoreConfirm` / modal input modern, perapihan sidebar & mobile backdrop, badge Instant vs Draft, micro-animations & SVG art helpers | `index.html`, `app.css`, `core.js` |
| **Tahap 3 — Overview Map & Charts** | Interactive Host/Service Health Map (Grid & Topology SVG), Fleet Donut & 24h Trend Sparkline | `monitor.js`, `index.html` |
| **Tahap 4 — Manage Diff Highlight, Discard & Bulk Services** | Highlight `NEW`/`MODIFIED`, modal `Review Changes`, `Discard Changes`, Bulk Delete Services, label Instant vs Draft di Notifications/Templates/Scripts | `manage.js`, `monitor.js` |
| **Tahap 5 — Complete Interactive User Guide** | 6 tab panduan mendetail + search internal Guide + tombol jump langsung ke menu terkait | `guide.js`, `index.html` |
| **Verifikasi & Push** | `go test -v ./...`, `go build`, `node --check web/js/*.js`, commit terstruktur, push ke `origin/master` | — |
