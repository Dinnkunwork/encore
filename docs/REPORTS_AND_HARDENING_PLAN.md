# Rencana Tahapan: Encore v4 — Historical Reports, SLA Export & Security Hardening

Dokumen ini merinci rencana pengembangan **Encore v4** untuk menutup kekurangan dibanding Nagios Core Classic (laporan historis, SLA/Availability report, export laporan, validasi TLS `check_http`, dan opsi autentikasi bawaan) — tetap mempertahankan prinsip **zero external database & single binary Go**.

---

## 1. Sumber Data Historis (Tanpa Database Eksternal)

Nagios Core secara native sudah mencatat seluruh riwayat event ke:
- Log aktif: `/usr/local/nagios/var/nagios.log`
- Arsip harian/bulanan: `/usr/local/nagios/var/archives/nagios-*.log`

Go dapat mem-parse file log tersebut dengan sangat cepat untuk membangun **Alert History**, **Event Log**, dan **SLA / Availability Report** secara *on-demand* (dengan cache ringan untuk rentang arsip).

---

## 2. Tahapan Implementasi

### Tahap R1 — Historical Log Parser, SLA Engine & Report Exporter (Backend Go)
- **Target File:** `api/state-gateway/reports.go`, `api/state-gateway/main.go`.
- **Flag baru di `encore-state-gateway`:**
  - `-nagios-log /usr/local/nagios/var/nagios.log`
  - `-archives-dir /usr/local/nagios/var/archives`
- **Endpoint API baru:**
  1. **`GET /api/v1/reports/events`** — Alert History, Notification Log & Event Log:
     - Parameter: `from`, `to` (Unix timestamp), `type` (`all|host_alert|service_alert|notification|downtime`), `host`, `state`, `hard_only`, `search`, `limit`, `offset`.
  2. **`GET /api/v1/reports/availability`** — SLA / Uptime Availability Report (pengganti modern `avail.cgi`):
     - Parameter: `from`, `to`, `target` (`hosts|services`), `hostgroup`, `host`.
     - Menghitung per objek: **Uptime % (`UP`/`OK`)**, **Warning %**, **Critical/Down %**, **Scheduled Downtime %**, **Total HARD Incidents**, dan **MTTR (Mean Time To Recovery)**, plus ringkasan **Overall SLA %**.
  3. **`GET /api/v1/reports/export`** — Generate & Download Report:
     - `format=csv` → file `.csv` siap buka di Excel / Google Sheets.
     - `format=html` → laporan rapi *print-ready* (langsung klik **Print / Save as PDF** dari browser tanpa dependensi PDF berat di server).
     - `format=json` → untuk otomasi / integrasi sistem lain.

### Tahap R2 — Halaman `Reports` di Dashboard (Modular `web/js/reports.js`)
- **Sidebar:** Menambahkan 1 menu `Reports` di grup **Monitoring** (total 7 menu yang tetap ringkas) dengan 3 clean underline sub-tabs:
  1. **`SLA`** — Preset rentang waktu (`24h` • `7d` • `30d` • `Custom`), filter Hostgroup/Host, 3 kartu KPI (**Overall SLA %**, **Total Incidents**, **Avg MTTR**), tabel uptime dengan visual bar hijau/merah, serta tombol **Export CSV** & **Print / PDF**.
  2. **`Alerts`** — Riwayat `HOST ALERT`, `SERVICE ALERT`, dan `NOTIFICATION` lengkap dengan filter `HARD Only`, Host, dan pencarian.
  3. **`Event Log`** — Viewer log sistem Nagios modern (pengganti `showlog.cgi`) dengan highlight warna per tipe event.

### Tahap R3 — Security & Worker Hardening (Menutup Temuan Review)
1. **Strict TLS Verification untuk `check_http` (`worker/go-worker/main.go`):**
   - Memisahkan `httpCliStrict` (`InsecureSkipVerify: false`, default untuk `check_http -S` agar sertifikat SSL expired/invalid terdeteksi CRITICAL) dan `httpCliInsecure` (`InsecureSkipVerify: true`, khusus untuk `check_ncpa.py` dan `check_http -S -k`).
2. **Optional Built-in Basic Auth (`api/state-gateway/main.go`):**
   - Flag opsional `-auth-user` dan `-auth-pass` (menggunakan `crypto/subtle.ConstantTimeCompare`). Jika tidak diisi, berjalan terbuka seperti biasa; jika diisi, seluruh dashboard & API otomatis terlindungi login.

### Tahap R4 — Verifikasi & Update Dokumentasi
- Unit test Go untuk parser `nagios.log`, kalkulasi SLA Availability %, export CSV/HTML, strict TLS vs `-k` di `go-worker`, dan Basic Auth middleware.
- Update `docs/DEPLOYMENT_GUIDE.md` dengan konfigurasi flag `-nagios-log`, `-archives-dir`, dan opsi `-auth-user`/`-auth-pass`.
