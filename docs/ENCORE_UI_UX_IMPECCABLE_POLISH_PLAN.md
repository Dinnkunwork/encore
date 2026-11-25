# Master Plan — Encore UI/UX Impeccable Overhaul (Anti-AI-Slop & NOC Craft)

Plan menyeluruh berbasis hasil **Dual-Agent Impeccable Critique** (`19/40 → target 35+/40`) untuk membenahi seluruh temuan **P0, P1, P2** serta meningkatkan kualitas visual & interaksi **Overview**, **Inventory**, **Global Shell**, dan **Drawers** ke standar **Operate-mode precision instrument** (bersih, konsisten, bebas *AI slop*, cepat untuk triage insiden).

---

## Prinsip Anti-AI-Slop (Impeccable Operate Mode)

1. **Precision Instrument, Bukan Template SaaS Generik:**
   - Hapus **6 bahasa ikon yang bertabrakan** (emoji OS `🔔`/`📺`, simbol Unicode mentah `↻`/`✓`/`⏱`/`ⓘ`, maskot pixel-art di tampilan operasional, tile background dekoratif `circuit-tile.png` / `stars-tile.png`, dan pseudo-element `View ›` yang repetitif).
   - Ganti dengan **1 sistem ikon SVG stroke 16px yang seragam** (`uiIcon(name)`), permukaan neutral berlapis halus, garis hairline (`1px`), dan angka `tabular-nums` yang tajam.
2. **Incident-First Hierarchy:**
   - Elemen paling kritis (*Unhandled Problems*, status koneksi *Offline/Stale*) selalu menang secara visual dan berada di atas lipatan layar (*above the fold*).
3. **Working Memory ≤ 4 per Titik Keputusan:**
   - Ringkas topbar dari 9 kontrol menjadi ≤ 4 kontrol utama; rapikan header Host Accordion menjadi 3 zona pemindaian jelas; tambahkan tombol *Clear Filters*.
4. **Satu Bahasa Seragam (100% English untuk Operate UI):**
   - Hilangkan campuran Indonesia/Inggris di layar yang sama (mis. `Menampilkan 1–50 dari 120 host` di atas `Showing 1–50 of 120 hosts`).

---

## Fase Implementasi (Berurutan dari P0 → P2 → Craft Polish)

### Fase 1 — Production Hardening & Safety (`$impeccable harden`) [P0]
**Target File:** `api/state-gateway/web/index.html`, `web/js/core.js`, `web/js/monitor.js`, `web/css/app.css`
1. **Stale / Disconnected Banner (Zero False-Green Data):**
   - Tambahkan sticky banner `#conn-banner` di bagian atas `.main` saat SSE terputus atau fetch API gagal, menampilkan timestamp snapshot terakhir (*"Connection lost — showing stale data from HH:MM:SS"*) + tombol **Retry Now**.
2. **Error Handling & Loading Skeletons:**
   - Bungkus seluruh `fetch()` di `loadMeta()`, `loadOverview()`, `loadMonitorView()`, dan `renderDowntimesView()` dengan helper `apiFetchJSON()` (`try/catch` + cek `res.ok`).
   - Tampilkan *error card* dengan tombol **Retry** jika gagal (tidak lagi macet di `"Loading..."`).
   - Ganti teks `"Loading..."` dengan **shimmer skeleton** berdimensi tetap di Overview, Inventory, dan `#drawer-metrics-box` (mencegah *layout shift*).
3. **RBAC Konsisten & Guardrail Tombol Destruktif:**
   - Terapkan `canOperate()` dan `isAdmin()` secara konsisten di `openHostDrawer()`, Quick Actions Overview (`#ov-prob-body`), dan aksi baris `Inventory → By Host`.
   - Ganti tombol `Disable` / `Enable` yang bersebelahan di Drawer menjadi aksi terproteksi **`encoreConfirm({ danger: true })`** agar tidak bisa salah klik mematikan monitoring.
   - Tambahkan state *busy/disabled* pada tombol submit saat request sedang berjalan untuk mencegah *double-submit*.
   - Ganti indeks array global `S.lastItems[idx]` yang rawan *race condition* SSE dengan lookup objek/key langsung.

### Fase 2 — Incident-First Hierarchy & Distilled Chrome (`$impeccable distill`) [P1]
**Target File:** `api/state-gateway/web/index.html`, `web/js/core.js`, `web/js/monitor.js`, `web/css/app.css`
1. **Overview Incident-First:**
   - Saat `unhandled > 0`, panel **Unhandled Problems** otomatis naik ke posisi paling atas di bawah KPI (dengan aksen border kiri merah yang tegas), sehingga langsung terlihat tanpa scroll di laptop 13".
   - Ganti kartu KPI ke-4 **`Engine PID`** dengan **`24h Service SLA`** (atau **`Active Downtimes`**) yang jauh lebih berguna bagi operator; info `PID` tetap rapi di subtitle header & menu `System`.
   - Tambahkan indikator jumlah di **Fleet Health Grid** jika total host > 24 (`"Showing 24 of N hosts — open Inventory for full list"`).
2. **Topbar Ringkas (≤ 4 Kontrol):**
   - Gabungkan `#theme-select`, `#alert-sound-btn`, dan `#tv-mode-btn` ke dalam satu popover **`Display`** (`#display-menu-btn`), sehingga `.topbar-right` hanya berisi:
     1. Search box + shortcut badge (`Ctrl+K`)
     2. `Live / Paused` toggle + Refresh `↻`
     3. `Display ▾` (Theme, Alert Sound, TV Mode)
     4. User chip
   - Hapus duplikasi status Live yang bertabrakan antara sidebar dan topbar.
3. **Inventory Controls & Accordion Header:**
   - Tambahkan tombol **`Clear Filters`** yang muncul otomatis saat ada filter/search aktif.
   - Rapikan `.host-acc-head` menjadi 3 blok yang mudah dipindai:
     - **Kiri:** Chevron + Checkbox + Host Badge + Nama Host & IP (maks 2 hostgroup tag)
     - **Tengah:** Stacked Health Bar + Ringkasan Service (`4/5 OK` / `1 CRIT`)
     - **Kanan:** Quick Actions seragam (`Force Check`, `Downtime`, `Details`)
   - Perbaiki bug collapse accordion di `monitor.js`: gunakan `S.invCollapsedHosts` (explicit collapse oleh user selalu menang atas auto-expand saat search aktif atau host ≤ 2).
   - Pisahkan filter `host` dari `#global-search` saat klik host dari Overview (atau tampilkan chip filter host yang bisa di-clear dengan 1 klik).

### Fase 3 — Technical Bugs, WCAG AA Contrast & Keyboard-First A11y (`$impeccable audit`) [P1]
**Target File:** `api/state-gateway/web/css/app.css`, `web/index.html`, `web/js/core.js`, `web/js/monitor.js`, `web/js/reports.js`
1. **Perbaikan Z-Index & Clipping:**
   - Pindahkan universal reset `* { box-sizing: border-box; margin: 0; padding: 0; }` ke baris paling atas `app.css`.
   - Rapikan hierarki z-index: `.topbar (20)` < `.sb-backdrop (25)` < `.sidebar (30)` < `.drawer-wrap (40)` < `.backdrop / modal / quick-jump (50)` < `.chart-tooltip (55)` < `#toast (60)` & `.btn.tv-exit-btn (60, bottom: 18px; left: 18px)` agar tidak pernah saling menimpa.
   - Izinkan `.chart-tooltip` tampil utuh tanpa terpotong `.panel` (ubah kontainer chart agar `overflow: visible` dan flip otomatis ke bawah jika terlalu dekat tepi atas).
2. **Kontras WCAG 2.1 AA di Semua 5 Tema:**
   - Tambahkan token `--accent-fg` dan `--crit-btn-fg` di setiap blok tema (`light`, `dark`, `cyber`, `nord`, `emerald`) sehingga teks di atas tombol primary/active/hover selalu mencapai rasio kontras **≥ 4.5:1**.
   - Perbaiki `--sidebar-muted` (≥ 4.5:1 di semua tema) dan override `--sidebar-active` / `--sidebar-active-fg` agar selaras dengan masing-masing tema.
   - Hapus 16 nilai hex *hardcoded* di luar blok tema `app.css`.
3. **Keyboard-First & Screen Reader A11y:**
   - Tambahkan `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` secara global.
   - Tambahkan navigasi **`ArrowUp` / `ArrowDown` / `Enter`** pada **`Ctrl+K` Quick Jump** (`#qj-list`) dengan highlight item aktif.
   - Tambahkan `tabindex="0"`, `role="button"`, `aria-expanded`, dan handler `Enter`/`Space` pada `.kpi-card`, `.host-tile`, `.host-acc-head`, dan `<tr class="clickable">`.
   - Tambahkan `title` dan `aria-label` pada seluruh tombol sidebar (termasuk mode collapsed), `.icon-btn`, dan tombol tutup drawer; tambahkan `role="status" aria-live="polite"` pada `#toast`, `role="dialog" aria-modal="true"` pada drawer/modal, dan `<h1>` semantik untuk judul halaman.
4. **Responsive Mobile (390px):**
   - Ubah `.kv-grid` dan `.form-grid` menjadi 1 kolom di `max-width: 520px`; kurangi `padding-left` `.host-acc-body` di mobile; perbesar area sentuh `.icon-btn` minimal `34×34px` (mobile `40×40px`).

### Fase 4 — Drawer Flow, Unified Iconography & URL Routing (`$impeccable layout` + `$impeccable polish`) [P2]
**Target File:** `api/state-gateway/web/js/core.js`, `web/js/monitor.js`, `web/css/app.css`
1. **Inline Ack & Downtime di dalam Drawer:**
   - Saat klik `Acknowledge` atau `Downtime` di Host/Service Drawer, buka form ringkas **langsung secara inline di dalam drawer** (tanpa menutup drawer!), sehingga `plugin_output` tetap terlihat saat operator menulis komentar.
   - Pindahkan baris tombol aksi utama ke **atas** `#drawer-metrics-box` agar tidak pernah bergeser saat grafik 6 jam selesai dimuat.
2. **Unified Crisp SVG Icon System & Anti-Slop Polish:**
   - Buat helper `uiIcon(name)` (SVG stroke 1.75px seragam untuk `refresh`, `check`, `clock`, `info`, `bell`, `tv`, `sliders`, `chevron`, `x`, `alert`, `server`, `check-circle`) menggantikan emoji OS, simbol Unicode acak, dan maskot pixel di tampilan operasional.
   - Hapus background tile dekoratif `circuit-tile.png` / `stars-tile.png` dan pseudo-element `View ›` di KPI card; perhalus spacing & tipografi.
3. **URL Hash Routing & Copy Cleanup:**
   - Sinkronkan `view` & `subtab` ke `location.hash` (mis. `#inventory/byhost`, `#overview`, `#problems/active`) + listener `hashchange` agar tombol Back/Forward & refresh browser bekerja normal.
   - Seragamkan seluruh copy UI Overview & Inventory ke **English** yang ringkas dan profesional.
   - Ganti inline `esc()` pada handler `onclick` dengan `jsEsc()` secara menyeluruh.

### Fase 5 — Dokumentasi Sistem Desain & Verifikasi
**Target File:** `docs/DESIGN.md`, `api/state-gateway/main_test.go`
1. Dokumentasikan token warna, skala tipografi, hierarki z-index, dan aturan komponen di `docs/DESIGN.md` agar perubahan mendatang konsisten.
2. Jalankan `go test -v ./...`, `go build`, dan `node --check` pada seluruh file JS, lalu verifikasi ulang dengan review kualitas akhir sebelum commit & push ke `master`.

---

## Ringkasan Dampak yang Diharapkan
- **Design Health Score:** `19/40 (Poor)` → target **`35+/40 (Good–Excellent)`**
- **Cognitive Load:** `6/8 gagal` → target **`0–1/8 gagal`**
- **WCAG AA Contrast:** `4 tema gagal` → **`5/5 tema PASS`**
- **Performa:** Tetap ringan (< 30ms API, 0 dependensi eksternal tambahan, pure CSS + Vanilla JS + SVG).
