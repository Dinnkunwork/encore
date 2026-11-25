# Encore Design System (`DESIGN.md`) — Swiss Control Room

Panduan sistem desain permanen untuk **Encore Control Room** (`api/state-gateway/web/`), dibangun pada dunia visual **Swiss Control Room** (Braun / Dieter Rams / Teenage Engineering Field — *Operate Mode*):

---

## 1. Visual World & Signature Elements

- **Material & Palette:** Warm alabaster paper (`#F3F1EC` / `#FAF9F5`) + deep graphite ink (`#141413`) + **Signal Vermilion** (`#D9381E`, 5.02:1 WCAG AA) di tema default *Alabaster Field*, serta matte carbon (`#0D0E10`) + `#FF5733` di *Carbon Studio*.
- **Architectural Hairline Grid (`--radius: 4px`):** Mengganti kartu melayang SaaS generik dengan papan instrumen terbagi garis `1px` presisi (`--border-strong`), termasuk **Chronograph KPI Strip** 4-kolom terpadu dengan LED annunciator.
- **Live SSE Oscilloscope Ribbon (`#telemetry-ribbon`):** Pita telemetri 60fps Canvas 2D di bawah topbar yang memancarkan pulsa real-time setiap SSE event masuk + live event ticker + NOC wall clock.
- **Aviation Annunciator Badges (`2px` radius):** Pill status bertepi tajam dengan indikator LED kotak 6px (`UP`, `DOWN`, `OK`, `WARN`, `CRIT`, `PEND`).
- **Native View Transitions API:** Transisi halaman halus (`document.startViewTransition`) dengan fallback instan & hormat pada `prefers-reduced-motion`.
- **Interactive Radial Orbital Topology:** Diagram hub-and-spoke dengan cincin jarak konsentris, sumbu crosshair, dan node host radial yang dapat diklik.
- **Swiss Split Login (`web/login.html`):** Layout 2-kolom arsitektural (masthead karbon dengan foto perangkat keras `swiss-control-hero.jpg`, emblem `encore-emblem.png`, beacon `telemetry-beacon.gif` + jam live di kiri; panel sign-in alabaster presisi di kanan).
- **Bespoke Visual Assets (`web/assets/`):**
  - `scenes/swiss-control-hero.jpg` — Foto studio perangkat telemetri anodized aluminium (Login & Guide hero).
  - `scenes/fleet-calm.jpg` — Relief alabaster minimalis (Overview *Fleet Nominal* banner).
  - `logo/encore-emblem.png` + favicons — Emblem presisi Swiss Bauhaus (Sidebar, Login, Browser Tab).
  - `animated/telemetry-beacon.gif` & `animated/discovery-scan.gif` — GIF animasi telemetri & scanner jaringan 64-warna tajam.
  - `animated/signal-pulse.svg` — Ikon pulse SVG animasi 658 byte.
  - `icons/*.svg` — 12 ikon navigasi/panel seragam `1.8px` stroke.

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
