# Quick Installation & Deployment Guide — Encore (Nagios Core Optimized)

Panduan ringkas untuk mem-build dan men-deploy **Encore** (Nagios Core 4.x dengan optimasi Fase 1–3: `@state` Query Handler + NERD `stateevents`, Go State API Gateway, Go Specialized Worker, dan Async CoW Persistence) di server Linux (Ubuntu/Debian).

---

## 1. Prasyarat Sistem

```bash
sudo apt update
sudo apt install -y build-essential libssl-dev autoconf automake git
# Opsional: hanya jika Anda masih butuh classic CGI grafik (statusmap/trends)
# sudo apt install -y libgd-dev
```

Install **Go 1.23+** (untuk build `state-gateway` dan `go-worker`; tidak dibutuhkan di server target jika Anda menyalin binary hasil build):
```bash
curl -fsSL https://go.dev/dl/go1.23.6.linux-amd64.tar.gz -o /tmp/go.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tar.gz
export PATH="/usr/local/go/bin:$PATH"
go version
```

---

## 2. Build Rilis (Production `-O2`)

> **Penting:** Untuk produksi, **jangan** gunakan `--enable-testing` agar binary dikompilasi dengan optimasi `-O2` tanpa overhead `gcov`.

```bash
git clone https://github.com/Dinnkunwork/encore.git
cd encore

# 1. Build Nagios Core (wajib --enable-event-broker --enable-nerd)
./configure --enable-event-broker --enable-nerd
make -j"$(nproc)" all

# 2. Build Go State API Gateway (Fase 1)
(cd api/state-gateway && go build -o state-gateway .)

# 3. Build Go Specialized Worker (Fase 2)
(cd worker/go-worker && go build -o go-worker .)
```

---

## 3. Instalasi ke `/usr/local/nagios`

```bash
sudo make install-groups-users
sudo make install
sudo make install-daemoninit
sudo make install-commandmode
sudo make install-config

# Salin binary Go ke direktori bin Nagios
sudo install -m 0755 api/state-gateway/state-gateway /usr/local/nagios/bin/encore-state-gateway
sudo install -m 0755 worker/go-worker/go-worker /usr/local/nagios/bin/encore-go-worker
```

---

## 4. Konfigurasi Optimal (`/usr/local/nagios/etc/nagios.cfg`)

Tambahkan atau pastikan directive berikut aktif di `/usr/local/nagios/etc/nagios.cfg`:

```ini
# Wajib untuk NERD stateevents & Query Handler
event_broker_options=-1
query_socket=/usr/local/nagios/var/rw/nagios.qh

# External command pipe (dipakai POST /api/v1/command)
check_external_commands=1
command_file=/usr/local/nagios/var/rw/nagios.cmd

# Fase 1: Matikan penulisan status.dat jika sudah 100% memakai State API Gateway
status_file=/dev/null
# (Jika CGI lama masih dipakai, gunakan path normal + aktifkan async_status_save=1)
# status_file=/usr/local/nagios/var/status.dat
# async_status_save=1

# Fase 3: Non-blocking Copy-on-Write retention save
retain_state_information=1
retention_update_interval=60
async_retention_save=1

# Dashboard Full Management (CRUD Host/Service/Group/Command + Clone + Reload)
cfg_dir=/usr/local/nagios/etc/encore.d
```

Buat direktori `encore.d` dengan kepemilikan user `nagios`:
```bash
sudo mkdir -p /usr/local/nagios/etc/encore.d
sudo chown -R nagios:nagios /usr/local/nagios/etc/encore.d
```

Validasi konfigurasi sebelum start:
```bash
sudo -u nagios /usr/local/nagios/bin/nagios -v /usr/local/nagios/etc/nagios.cfg
```

---

## 5. Setup Systemd Services

### A. State API Gateway (`/etc/systemd/system/encore-state-gateway.service`)
```ini
[Unit]
Description=Encore Go State API Gateway
After=network.target nagios.service
Requires=nagios.service

[Service]
Type=simple
User=nagios
Group=nagios
ExecStart=/usr/local/nagios/bin/encore-state-gateway \
  -listen 0.0.0.0:8080 \
  -qh /usr/local/nagios/var/rw/nagios.qh \
  -cmd /usr/local/nagios/var/rw/nagios.cmd \
  -managed-dir /usr/local/nagios/etc/encore.d \
  -nagios-bin /usr/local/nagios/bin/nagios \
  -nagios-cfg /usr/local/nagios/etc/nagios.cfg \
  -resync-interval 5m
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

### B. Go Specialized Worker (`/etc/systemd/system/encore-go-worker.service`)
```ini
[Unit]
Description=Encore Go Specialized Persistent Worker
After=network.target nagios.service
Requires=nagios.service

[Service]
Type=simple
User=nagios
Group=nagios
ExecStart=/usr/local/nagios/bin/encore-go-worker \
  -name encore-fast-worker \
  -qh /usr/local/nagios/var/rw/nagios.qh \
  -plugins check_tcp,check_http,check_dummy \
  -max-jobs 512
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Aktifkan dan jalankan seluruh service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nagios encore-state-gateway encore-go-worker
```

---

## 6. Verifikasi Setelah Deploy

```bash
# 1. Cek status ketiga service
sudo systemctl status nagios encore-state-gateway encore-go-worker --no-pager

# 2. Cek kesehatan State API Gateway & live event NERD
curl -s http://127.0.0.1:8080/health | python3 -m json.tool

# 3. Cek ringkasan status real-time
curl -s http://127.0.0.1:8080/api/v1/summary | python3 -m json.tool

# 4. Pastikan Go Worker terdaftar di Nagios
grep "encore-fast-worker" /usr/local/nagios/var/nagios.log
```

---

## 7. Catatan Operasional & Rollback Cepat

- **Reverse Proxy:** `encore-state-gateway` di-bind ke `127.0.0.1:8080`. Jika ingin diakses dari luar server, letakkan di belakang Nginx/Caddy dengan HTTPS + autentikasi (Basic Auth / SSO / IP allowlist).
- **Rollback Worker (Fase 2):** `sudo systemctl stop encore-go-worker` — Nagios otomatis *fallback* ke core worker bawaan tanpa restart.
- **Rollback Async Save (Fase 3):** Ubah `async_retention_save=0` (dan `async_status_save=0`) di `nagios.cfg`, lalu `sudo systemctl reload nagios`.
- **Rollback API/CGI (Fase 1):** Kembalikan `status_file=/usr/local/nagios/var/status.dat` di `nagios.cfg` dan `sudo systemctl reload nagios`.
