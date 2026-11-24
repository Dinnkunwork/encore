# Rencana Tahapan: Encore v3 — Sidebar Ringkas (6 Menu), Secrets `$USERn$`, Modular `web/`, & Benchmark `-O2`

Dokumen ini merinci rencana penyempurnaan arsitektur UI, keamanan token NCPA, modularisasi frontend, serta benchmark build produksi `-O2`.

---

## 1. Perampingan Menu Sidebar (Dari 13 Menu → 6 Menu Utama)

Menu yang memiliki fungsi berdekatan digabung menjadi 1 menu utama dengan **underline/pill sub-tabs** yang singkat, bersih, dan tidak penuh teks:

| Grup Sidebar | Menu Utama | Sub-Tab di Dalam Halaman (Label Singkat) |
| :--- | :--- | :--- |
| **MONITORING** | **Overview** | *(Tactical Dashboard: 4 KPI cards, Unhandled Problems, Hostgroup Health, Activity)* |
| **MONITORING** | **Inventory** | `Services` • `Hosts` • `Groups` |
| **MONITORING** | **Problems** *(+ badge)* | `Active` • `Downtimes` |
| **MANAGEMENT** | **Manage** | `Hosts & Services` • `Localhost` • `Commands` • `Groups` • `Secrets` |
| **MANAGEMENT** | **System** | `Controls` • `Backups` • `Audit` |
| **HELP** | **Guide** | `Quick Start` • `NCPA` • `Catalog` • `Paths` |

**Keuntungan:**
- `Localhost Config` tidak lagi terpisah di sidebar — langsung menjadi sub-tab `Localhost` di dalam **Manage**.
- `Custom Scripts` terintegrasi rapi di dalam sub-tab `Commands` (bagian atas: Commands, bagian bawah: Custom Scripts + Test Run).
- `Groups & Contacts` tergabung rapi di sub-tab `Groups` pada **Manage**.
- Label tab maksimal 1–2 kata, menggunakan gaya **clean underline tabs** dengan counter badge kecil (mis. `Hosts 12`, `Services 48`).

---

## 2. Manajemen Token NCPA & Secrets via `resource.cfg` (`$USERn$`) — Poin 2

Agar token NCPA **tidak pernah tampil plaintext** di tabel UI maupun file `encore-services.cfg`:
- **Backend (`api/state-gateway/secrets_api.go`):**
  - `GET /api/v1/secrets`: Membaca semua macro `$USER1$`..`$USER32$` dari `/usr/local/nagios/etc/resource.cfg`. Nilai `$USER2$` ke atas dikirim dalam bentuk **masked** (`••••••1234`, hanya 4 karakter terakhir) ke UI; `$USER1$` (path plugin) tampil read-only sebagai info.
  - `POST /api/v1/secrets`: Menambah/mengubah `$USER2$`..`$USER32$` secara atomik ke `resource.cfg` (dengan validasi anti-injection, backup otomatis, dan reload via `RESTART_PROGRAM`).
  - `DELETE /api/v1/secrets?key=$USER2$`: Menghapus macro secret tertentu (`$USER1$` dilindungi dan tidak bisa dihapus).
- **Integrasi NCPA:**
  - Tombol **1-Click Register `check_ncpa`** menggunakan `$USER2$` secara default:
    ```text
    $USER1$/check_ncpa.py -H $HOSTADDRESS$ -t '$USER2$' -P 5693 -M $ARG1$ $ARG2$
    ```
  - Preset NCPA di modal `+ Add Service` menjadi lebih ringkas dan bebas token plaintext:
    - `check_ncpa!cpu/percent!-w 80 -c 90`
    - `check_ncpa!memory/virtual!-w 80 -c 90`
    - `check_ncpa!disk/logical/|/used_percent!-w 80 -c 90`
    - `check_ncpa!processes!-w 250 -c 400`

---

## 3. Refactor Modular Frontend `web/` (Tetap Zero-NPM) — Poin 3

Memecah `api/state-gateway/web/index.html` (~1.694 baris) menjadi modul bersih yang tetap di-embed dalam satu binary Go (`//go:embed web`):

```text
api/state-gateway/web/
├── index.html          # Shell layout (Sidebar 6 menu + Topbar + container + modal/drawer)
├── css/
│   └── app.css         # Design system, dark/light tokens, button affordance, clean underline tabs
├── js/
│   ├── core.js         # State, fetch helpers, toast, modal, drawer, formatters, badges
│   ├── monitor.js      # Overview, Inventory (Services/Hosts/Groups), Problems & Downtimes
│   ├── manage.js       # Manage (Hosts & Services, Localhost, Commands & Scripts, Groups, Secrets), System
│   └── guide.js        # User Guide visual & ringkas (Quick Start, NCPA, Live Catalog, Paths)
└── assets/             # Brand SVG & Favicon (tidak berubah)
```

Routing di `main.go` melayani `/css/*` dan `/js/*` langsung dari `webFS` (sama seperti `/assets/*`).

---

## 4. Redesign Konten `User Guide` (Lebih Visual, Ringkas & Tidak Banyak Teks)

- Mengurangi paragraf panjang → diganti dengan:
  - **Quick Start:** 3 kartu alur visual (`1. Monitor & Triage`, `2. Tambah / Clone Config`, `3. Validate & Reload`) + tabel legend status ringkas.
  - **NCPA:** 3 langkah singkat (Install di target → Simpan token di `Manage → Secrets ($USER2$)` → Klik 1-Click Register `check_ncpa` & pakai Preset).
  - **Catalog:** Tabel pencarian live Commands & Plugins + tombol Copy.
  - **Paths:** Tabel ringkas lokasi file server & exit code (`0/1/2/3`).

---

## 5. Benchmark Ulang Build Produksi (`-O2` tanpa `--enable-testing`) — Poin 5

- Menjalankan build rilis bersih: `./configure --enable-event-broker --enable-nerd && make -j4 all` (`-O2`, tanpa `-O0` & `gcov`).
- Menjalankan ulang `bench/run_baseline.py`, `bench/bench_fase1.py`, dan `bench/bench_fase2.py` pada binary `-O2` lalu mencatat perbandingan angka produksi di `docs/BASELINE_BENCHMARK.md`.

---

## Urutan Eksekusi
1. **Tahap V3-1:** Backend `secrets_api.go` (`$USERn$` di `resource.cfg`) + unit test + update routing `/css/` & `/js/` di `main.go`.
2. **Tahap V3-2:** Refactor modular `web/` (`index.html`, `css/app.css`, `js/core.js`, `js/monitor.js`, `js/manage.js`, `js/guide.js`) dengan Sidebar 6 menu, underline sub-tabs elegan, integrasi Localhost & Secrets di dalam `Manage`, serta User Guide yang ringkas.
3. **Tahap V3-3:** Build produksi `-O2`, verifikasi semua unit test + live test, dan jalankan benchmark `-O2` untuk dokumentasi.
4. **Tahap V3-4:** Commit rapi & push ke GitHub.
