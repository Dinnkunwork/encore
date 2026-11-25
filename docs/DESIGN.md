# Encore Design System (`DESIGN.md`)

Panduan sistem desain permanen untuk **Encore Operations Console** (`api/state-gateway/web/`), disusun dengan standar **Operate Mode** (presisi, bebas dekorasi berlebih, kontras WCAG 2.1 AA, *incident-first*).

---

## 1. Mode & Prinsip Visual

- **Surface Mode:** `Operate` (NOC Monitoring & Infrastructure Operations).
- **Elevation:** Gunakan border `1px solid var(--border)` untuk panel dan kartu di bidang kerja; gunakan `var(--shadow-overlay)` **hanya** untuk elemen mengambang (drawer, modal, popover, tooltip, toast). Jangan menggabungkan border + drop-shadow lebar pada kartu statis.
- **No Decorative Noise:** Dilarang menggunakan tile background dekoratif, maskot pixel-art di layar triage operasional, emoji OS sebagai ikon tombol, atau pseudo-element berulang (`View ›`) pada kartu KPI.
- **Typography:** Satu keluarga sans sistem + monospace khusus data/IP/metric dengan `font-variant-numeric: tabular-nums`. Judul halaman wajib `<h1>`.
- **Copy:** 100% **English** konsisten pada seluruh tampilan Operate (`Overview`, `Inventory`, `Problems`, `Reports`, `Manage`, `System`).

---

## 2. Token Warna & Kontras (WCAG 2.1 AA ≥ 4.5:1)

Seluruh warna didefinisikan melalui CSS custom properties di [app.css](file:///home/dinnkun/projects/encore/api/state-gateway/web/css/app.css) untuk 5 tema (`light`, `dark`, `cyber`, `nord`, `emerald`):

| Token | Fungsi | Kontras |
| :--- | :--- | :--- |
| `--bg`, `--surface`, `--surface-2` | 3 lapis permukaan netral (canvas, panel, header/kontrol) | — |
| `--text`, `--muted` | Teks utama & sekunder | ≥ 4.5:1 di atas `--bg`/`--surface`/`--surface-2` |
| `--accent`, `--accent-fg` | Aksi utama, tab aktif, focus ring, dan teks kontras di atas aksen | ≥ 4.5:1 di semua 5 tema (`#ffffff` di `light`/`dark`, gelap di `cyber`/`nord`/`emerald`) |
| `--ok`, `--warn`, `--crit`, `--unk` | Warna semantik status (selalu berpasangan dengan teks/badge, tidak warna saja) | ≥ 4.5:1 untuk `--*-fg` pada `--*-bg` |
| `--sidebar-bg`, `--sidebar-muted`, `--sidebar-active-fg` | Navigasi kiri yang selaras per tema | ≥ 4.5:1 di semua 5 tema |

---

## 3. Hierarki Z-Index

| Layer | Selector | `z-index` |
| :--- | :--- | :--- |
| Sticky Connection Banner | `.conn-banner` | `19` |
| Sticky Topbar | `.topbar` | `20` |
| Mobile Sidebar Backdrop | `.sb-backdrop` | `25` |
| Sidebar | `.sidebar` | `30` |
| Slide-over Drawer | `.drawer-wrap` | `40` |
| Modals, Confirm Dialog, Quick Jump, Display Popover | `.backdrop`, `.display-menu` | `50` |
| Interactive Chart Tooltips | `.chart-tooltip` | `55` |
| Toast (`bottom-right`) & Exit TV Mode (`bottom-left`) | `#toast`, `.btn.tv-exit-btn` | `60` |

---

## 4. Aturan Komponen & Interaksi

1. **Unified Stroke Icons:** Gunakan helper `uiIcon(name)` (16px SVG stroke `1.8px`) untuk seluruh ikon aksi UI (`refresh`, `check`, `clock`, `info`, `chevron`, `x`, `alert`, `ok`, `server`, `search`, `shield`).
2. **Keyboard & Focus:** `:focus-visible` global aktif; `Ctrl+K` Quick Jump wajib mendukung `ArrowUp` / `ArrowDown` / `Enter` / `Esc`; elemen interaktif wajib memakai `<button>` atau `role="button" tabindex="0"` dengan `Enter`/`Space`.
3. **Inline Before Modal:** Aksi kontekstual di dalam Drawer (`Acknowledge`, `Downtime`) dirender **inline** di dalam drawer agar `plugin_output` tetap terlihat.
4. **Safety & Resilience:**
   - Banner `#conn-banner` wajib muncul saat SSE/API gagal agar data lama tidak pernah terlihat "sehat palsu".
   - Aksi destruktif (`Disable Checks`, `Cancel Downtime`, `Delete`) wajib melewati `encoreConfirm({ danger: true })`.
   - Seluruh tombol mutasi wajib dipagari `canOperate()` / `isAdmin()`.
5. **URL Hash Routing:** State view & subtab disinkronkan ke `location.hash` (`#overview`, `#inventory/byhost`, dll.) agar tombol Back/Forward dan refresh browser bekerja mulus.
