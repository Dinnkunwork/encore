# Plan — Encore Inventory Host-Grouped View (Host & Services Accordion)

## Latar Belakang & Masalah Saat Ini

Pada menu **Inventory** saat ini:
- Tab default **Services** menampilkan tabel datar (*flat list*) berisi 50 service per halaman dari berbagai host.
- Tombol **Grouped** yang ada hanya menyisipkan baris pemisah (`<tr class="group-row">`) di dalam halaman yang sedang aktif — akibatnya:
  1. Service milik **1 host bisa terpotong antar halaman** atau terpisah saat diurutkan berdasarkan *severity*.
  2. Status host itu sendiri (`UP`/`DOWN`), alamat IP, dan ringkasan kesehatan service per host (`4/5 OK`, `1 CRIT`) tidak terlihat pada header grup.
  3. Grup tidak bisa di-**expand / collapse** (accordion), sehingga sulit memantau 1 host tertentu beserta seluruh service-nya secara ringkas.

---

## Tujuan Desain

Menjadikan menu **Inventory** jauh lebih jelas, terstruktur per host, dan tetap instan (< 30ms) bahkan untuk ratusan host & ribuan service:
- User langsung melihat **daftar Host** beserta status host, IP, ringkasan health bar service, dan jumlah `OK / WARN / CRIT`.
- Klik header host untuk **expand/collapse** dan langsung melihat **seluruh service yang dimonitor pada host tersebut** secara utuh (tidak pernah terpotong pagination).

---

## Rencana Implementasi

### 1. Backend — Endpoint Terpadu `GET /api/v1/inventory/by-host`
**File:** `api/state-gateway/main.go`
- Menambahkan method `StateStore.QueryInventoryByHost(opts QueryOpts)` yang mengelompokkan host beserta seluruh service-nya di memori (`RLock`, < 2ms, otomatis terkompresi `gzip`):
  - **Pagination berbasis Host** (`limit` = jumlah host per halaman, misal 25/50/100) sehingga service milik satu host **tidak pernah terpotong** antar halaman.
  - **Filter terpadu:**
    - `search`: cocokkan ke nama host, IP address, nama service, atau plugin output. Jika cocok ke service tertentu, host tetap muncul dengan service yang cocok.
    - `hostgroup` & `servicegroup`: filter langsung pada level host/service.
    - `state`: dukung filter `all`, `problems` (host DOWN atau punya service WARN/CRIT/UNK), `healthy` (host UP & semua service OK), atau state spesifik (`0`/`1`/`2`/`3`).
    - `unhandled=1`: tampilkan hanya host/service yang memiliki problem belum ditangani.
    - `sort`: `severity` (host bermasalah di atas, lalu alfabetis), `name` (A–Z), `services` (jumlah service terbanyak).
  - **Payload per host:** objek `HostState` lengkap, daftar `hostgroups`, agregat (`svc_ok`, `svc_warn`, `svc_crit`, `svc_unk`, `svc_pend`, `svc_total`, `has_problem`), serta array `services` (terurut `CRIT → WARN → UNK → OK`).

### 2. Frontend — Sub-Tab `By Host` (Default Inventory) & Accordion UI
**File:** `api/state-gateway/web/js/core.js`, `api/state-gateway/web/js/monitor.js`, `api/state-gateway/web/css/app.css`
- **Urutan Sub-Tab Inventory:**
  - **`By Host`** *(default baru — Host & Services Accordion)*
  - **`Services`** *(flat list semua service, tetap tersedia untuk pencarian cepat lintas host)*
  - **`Hosts`** *(tabel ringkas daftar host saja)*
  - **`Groups`** *(kartu Hostgroups & Servicegroups)*
- **Tampilan Kartu / Accordion per Host (`By Host`):**
  - **Header Host (klik untuk expand/collapse):**
    - Chevron `▶` + Checkbox (memilih seluruh service host tsb untuk Bulk Action).
    - Badge status host (`UP` / `DOWN` / `UNREACH` / `PENDING`) + **Nama Host** + **IP Address** + tag hostgroup.
    - **Health Summary Bar** + pill ringkas (`5/5 OK`, atau highlight merah/kuning jika ada `1 CRIT` / `2 WARN`).
    - **Quick Actions Host** di kanan header: `↻` Force Check Host, `⏱` Downtime Host, `ⓘ` Detail Host (buka Host Drawer).
  - **Body Accordion (saat di-expand):**
    - Tabel seluruh service milik host tersebut: Checkbox, Status Badge + Flags (`ACK`/`DT`/`SOFT`), Nama Service, State Age (`Duration`), Last Check, Plugin Output, dan Quick Actions (`↻`, `✓`, `⏱`).
    - Klik baris service langsung membuka **Service Drawer** (lengkap dengan grafik metrik interaktif 6 jam).
- **Kontrol Praktis:**
  - Tombol **`Expand All`** / **`Collapse All`** di toolbar Inventory.
  - **Auto-Expand Cerdas:** otomatis membuka accordion untuk host yang sedang bermasalah (jika jumlahnya <= 5) atau saat user mengetik pencarian di `Search (/)`, dan mempertahankan state expand selama live SSE refresh berjalan.
- **Integrasi Overview → Inventory:**
  - Klik tile host di **Overview → Fleet Health Map** langsung melompat ke **Inventory → By Host** dengan host tersebut ter-filter dan otomatis terbuka (*expanded*).

### 3. Verifikasi & Testing
**File:** `api/state-gateway/main_test.go`
- Menambahkan unit test untuk `GET /api/v1/inventory/by-host` (verifikasi grouping, host-level pagination tanpa memecah service, filter `search`, `hostgroup`, dan `problems`).
- Verifikasi `go test ./...`, `go build`, dan `node --check` pada seluruh JS.

---

## Dampak Performa
- **Sangat ringan / justru lebih hemat:** 1 request terkompresi gzip (`GET /api/v1/inventory/by-host`) menggantikan kombinasi query host + service terpisah; grouping dilakukan 100% di RAM Go (< 2ms) dan tidak menambah beban ke Encore Engine (`nagios`).
