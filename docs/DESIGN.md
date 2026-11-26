# Encore Design System (`DESIGN.md`) — Swiss Control Room

Panduan sistem desain permanen untuk **Encore Control Room** (`api/state-gateway/web/`), dibangun pada dunia visual **Swiss Control Room** (Braun / Dieter Rams / Teenage Engineering Field — *Operate Mode*):

---

## 1. Visual World & Signature Elements

- **Material & Palette:** Warm alabaster paper (`#F3F1EC` / `#FAF9F5`) + deep graphite ink (`#141413`) + **Signal Vermilion** (`#D9381E`, 5.02:1 WCAG AA) di tema default *Alabaster Field*, serta matte carbon (`#0D0E10`) + `#FF5733` di *Carbon Studio*. Seluruh 5 tema mengatur `color-scheme` (`light`/`dark`) agar permukaan browser (scrollbar, date picker, kontrol native) seragam.
- **Smooth Nested-Radius Geometry (`14px` / `12px` / `8px` / `6px` / `999px`):** Mengganti tepi tajam/kasar dengan skala radius konsentris (`--radius-lg: 14px` modal/hero, `--radius: 12px` panel/KPI strip/popover, `--radius-sm: 8px` tombol/input/dropdown/tile, `--radius-xs: 6px` badge/flag, `--radius-pill: 999px` LED & health bar) serta sudut dalam presisi (`calc(var(--radius) - 1px)`), border halus (`--border`), dan elevasi lembut (`--shadow-sm`).
- **Live SSE Oscilloscope Ribbon (`#telemetry-ribbon`):** Pita telemetri 60fps Canvas 2D di bawah topbar yang memancarkan pulsa real-time setiap SSE event masuk + live event ticker + NOC wall clock.
- **Precision Theme-Matched Form Controls:**
  - **Custom Checkboxes:** `appearance: none` dengan fill `var(--accent)`, centang animasi `var(--accent-fg)` (otomatis kontras di semua 5 tema), state `:indeterminate`, dan highlight `.chk-pill:has(input:checked)`.
  - **Encore Sleek Dropdowns (`EncoreDropdown`):** Progressive enhancement otomatis untuk seluruh `<select>` dengan tombol trigger halus, chevron berputar, floating menu portal (`z-index: 65`) anti-clipping, active-filter tint, navigasi keyboard penuh (`↑`/`↓`/`Enter`/`Esc`), serta swatch warna untuk pemilih tema.
- **Smooth Annunciator Badges (`6px` radius):** Pill status dengan indikator LED bundar 6px (`UP`, `DOWN`, `OK`, `WARN`, `CRIT`, `PEND`).
- **Native View Transitions API:** Transisi halaman halus (`document.startViewTransition`) dengan fallback instan & hormat pada `prefers-reduced-motion`.
- **Interactive Radial Orbital Topology:** Diagram hub-and-spoke dengan cincin jarak konsentris, sumbu crosshair, dan node host radial yang dapat diklik.
- **Swiss Split Login (`web/login.html`):** Layout 2-kolom arsitektural (masthead karbon dengan foto perangkat keras `swiss-control-hero.jpg`, emblem SVG geometris bertema + jam live di kiri; panel sign-in bersih di kanan dengan theme switcher custom tanpa detail teknis internal).
- **Theme-Aware Brand Logo & Duotone Icon System (`web/js/encore-icons.js`):**
  - Emblem Encore menggunakan inline geometric SVG (`var(--accent)` + `var(--accent-fg)`) sehingga otomatis selaras di seluruh 5 tema (`light`, `dark`, `cyber`, `nord`, `emerald`).
  - Seluruh icon navigasi sidebar & header panel menggunakan inline duotone SVG (`1.75px` stroke `currentColor` + `14%` fill) yang mewarisi warna aktif tema.
  - **24 Host OS & Device Icons:** Katalog icon host (`linux`, `windows`, `ubuntu`, `debian`, `rhel`, `alpine`, `macos`, `freebsd`, `proxmox`, `vmware`, `docker`, `kubernetes`, `cloud`, `server`, `mikrotik`, `cisco`, `network`, `firewall`, `wifi`, `loadbalancer`, `database`, `web`, `synology`, `iot`) + auto-detect cerdas dan visual **Host Icon Picker** di Manage → Add/Edit Host, ditampilkan konsisten di Overview, Inventory, Manage, dan Host Detail Drawer.

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
| Sleek Dropdown Floating Menu Portal | `#ec-dd-portal`, `.ec-dd-menu` | `65` |

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
