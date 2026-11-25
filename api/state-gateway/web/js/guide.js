function setGuideTab(t) {
  S.guideTab = t;
  ['quick','menus','ncpa','notify','catalog','paths'].forEach(k => document.getElementById('gtab-'+k)?.classList.toggle('active', k===t));
  renderGuide();
}

function setNcpaOS(os) { S.ncpaOS = os; renderGuide(); }

function ncpaInstallSnippet(os) {
  if (os === 'rhel') {
    return `# 1. Tambah repo resmi Nagios & install NCPA (RHEL/Rocky/Alma 9; ganti 9 -> 8 untuk EL8)
sudo rpm -Uvh https://repo.nagios.com/nagios/9/nagios-repo-9-1.el9.noarch.rpm
sudo dnf install -y ncpa

# 2. Set token (harus sama dengan $USER2$ di Encore -> Manage -> Secrets)
sudo sed -i 's/^community_string = .*/community_string = TOKEN_ANDA/' /usr/local/ncpa/etc/ncpa.cfg
sudo systemctl enable --now ncpa

# 3. Buka port 5693/tcp HANYA dari IP Server Encore
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="IP_SERVER_ENCORE" port port="5693" protocol="tcp" accept'
sudo firewall-cmd --reload`;
  }
  if (os === 'windows') {
    return `# 1. Unduh installer NCPA (.exe) dari https://www.nagios.org/ncpa/#downloads
# 2. Jalankan wizard -> isi Token (sama dengan $USER2$ di Encore) -> Port 5693 -> Finish
# 3. (Opsional PowerShell Admin) Batasi firewall 5693 hanya dari IP Server Encore:
New-NetFirewallRule -DisplayName "Encore NCPA 5693" -Direction Inbound -Protocol TCP -LocalPort 5693 -RemoteAddress IP_SERVER_ENCORE -Action Allow`;
  }
  return `# 1. Tambah repo resmi Nagios & install NCPA (Ubuntu / Debian)
curl -sSL https://repo.nagios.com/GPG-KEY-NAGIOS-V3 | sudo gpg --dearmor -o /usr/share/keyrings/nagios.gpg
echo "deb [signed-by=/usr/share/keyrings/nagios.gpg] https://repo.nagios.com/deb/$(lsb_release -cs) /" | sudo tee /etc/apt/sources.list.d/nagios.list
sudo apt update && sudo apt install -y ncpa

# 2. Set token (harus sama dengan $USER2$ di Encore -> Manage -> Secrets)
sudo sed -i 's/^community_string = .*/community_string = TOKEN_ANDA/' /usr/local/ncpa/etc/ncpa.cfg
sudo systemctl enable --now ncpa

# 3. Buka port 5693/tcp HANYA dari IP Server Encore
sudo ufw allow from IP_SERVER_ENCORE to any port 5693 proto tcp`;
}

function guideMatches(q, text) {
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

async function renderGuide() {
  const el = document.getElementById('guide-content');
  const q = (document.getElementById('guide-search')?.value || '').trim().toLowerCase();

  if (S.guideTab === 'quick') {
    el.innerHTML = `
      <div class="guide-hero">
        <div class="guide-hero-copy">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
            <img src="/assets/logo/encore-emblem.png" alt="Encore" style="width:28px;height:28px;border-radius:3px;border:1px solid rgba(250,249,245,0.2)">
            <span class="badge c-ok">ENCORE v8 CONTROL ROOM</span>
          </div>
          <h2>Architecture &amp; Operator Workflow</h2>
          <p>Encore pairs a C monitoring engine, in-process Go check workers, and a real-time SSE Control Room into one low-latency operational instrument.</p>
        </div>
        <div class="guide-hero-img"><img src="/assets/scenes/swiss-control-hero.jpg" alt="Encore Hardware Telemetry"></div>
      </div>

      <div class="guide-card">
        <div class="guide-card-head"><h3>Core Components</h3></div>
        <ol class="guide-steps">
          <li><b>Encore Core Engine (C):</b> Schedules checks, maintains live memory state, and persists historical logs with non-blocking <i>Async CoW Save</i>.</li>
          <li><b>Encore Go Worker (<code>encore-go-worker</code>):</b> Executes <code>check_tcp</code>, <code>check_http</code> (Strict TLS &amp; SSL expiry <code>-C</code>), <code>check_dummy</code>, and <code>check_ncpa</code> in-process with zero fork overhead.</li>
          <li><b>Encore State Gateway &amp; Control Room (<code>encore-state-gateway</code>):</b> Streams live state over SSE (with the 60fps Oscilloscope Ribbon), serves the 5-theme Swiss Control Room UI, RBAC sessions, 7-day Time-Series Metrics, Scheduled SLA Digests, Network Discovery, and SMTP/Webhook alerts.</li>
        </ol>
      </div>

      <div class="guide-card">
        <div class="guide-card-head"><h3>Perbedaan Jenis Tombol Save di Encore</h3></div>
        <div class="cards-3" style="margin-bottom:0">
          <div class="step-card">
            <span class="save-scope-pill instant" style="margin-bottom:8px">Instant Save</span>
            <h4>Aktif Langsung Tanpa Reload</h4>
            <p>Digunakan di <b>Notifications (SMTP/Webhook)</b>, <b>Service Templates</b>, <b>Users (RBAC)</b>, <b>Scheduled Digest</b>, dan <b>Custom Scripts</b>. Langsung berlaku di Encore Gateway tanpa reload engine.</p>
          </div>
          <div class="step-card">
            <span class="save-scope-pill draft" style="margin-bottom:8px">Draft • Apply &amp; Reload</span>
            <h4>Staged Encore Config</h4>
            <p>Digunakan di <b>Hosts</b>, <b>Services</b>, <b>Commands</b>, <b>Groups</b>, dan <b>Contacts</b>. Perubahan ditandai badge <b>NEW / MODIFIED</b>. Anda bisa <b>Review Changes</b>, <b>Discard</b> (batal), <b>Validate</b>, lalu <b>Apply &amp; Reload</b>.</p>
          </div>
          <div class="step-card">
            <span class="save-scope-pill auto" style="margin-bottom:8px">Auto-Reload Encore</span>
            <h4>Secrets (resource.cfg)</h4>
            <p>Digunakan di <b>Manage → Secrets</b> (<code>$USER2$..$USER32$</code>). Menyimpan nilai ter-masking ke <code>resource.cfg</code> dan langsung me-reload Encore Engine secara aman.</p>
          </div>
        </div>
      </div>

      <div class="panel" style="padding:16px">
        <div class="kv-grid" style="margin:0">
          <div class="kv-box"><div class="k">Status &amp; Exit Code Plugin</div><div class="v" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <span class="badge c-ok"><img src="/assets/status/status-ok.svg">UP / OK (0)</span>
            <span class="badge c-warn"><img src="/assets/status/status-warn.svg">WARN (1)</span>
            <span class="badge c-crit"><img src="/assets/status/status-critical.svg">CRIT / DOWN (2)</span>
            <span class="badge c-unk"><img src="/assets/status/status-info.svg">UNK (3)</span>
            <span class="badge c-pend">PENDING</span>
          </div></div>
          <div class="kv-box"><div class="k">Keyboard Shortcuts &amp; Flags</div><div class="v" style="font-size:12.5px;font-weight:500;margin-top:6px;color:var(--muted)">
            <code class="code-chip">Ctrl+K</code> Quick Jump • <code class="code-chip">/</code> Search • <code class="code-chip">Esc</code> Close Modal/Drawer<br>
            <span class="flag-tag">ACK</span> Sudah ditangani • <span class="flag-tag">DT</span> Maintenance • <span class="flag-tag">SOFT</span> Retry awal • <span class="flag-tag">FLAP</span> Naik-turun
          </div></div>
        </div>
      </div>`;
  } else if (S.guideTab === 'menus') {
    const sections = [
      {
        title: '1. Overview — Ringkasan Eksekutif, Fleet Map & 24h Trend',
        nav: "setView('overview')",
        steps: [
          '<b>KPI Cards:</b> Menampilkan persentase Host UP, Service OK, jumlah masalah <i>Unhandled</i>, serta status engine (PID, Checks, Notify). Klik kartu mana pun untuk langsung masuk ke daftarnya.',
          '<b>Fleet Health Map:</b> Peta visual kesehatan seluruh host. Pilih mode <b>Health Grid</b> (tile padat berisi mini-bar service OK/WARN/CRIT) atau <b>Topology</b> (diagram SVG Hub-and-Spoke). Klik host untuk langsung melihat service-nya.',
          '<b>Distribution &amp; 24h Trend:</b> Donut distribusi status service saat ini + sparkline tren SLA 24 jam terakhir.',
          '<b>Unhandled Problems:</b> Menampilkan prioritas teratas masalah yang belum di-ACK/Downtime beserta tombol cepat Force Check (↻) dan Acknowledge (✓).'
        ]
      },
      {
        title: '2. Inventory & Problems — Monitoring Harian & Bulk Actions',
        nav: "setView('inventory','services')",
        steps: [
          '<b>Inventory (Services / Hosts / Groups):</b> Pantau seluruh objek secara real-time. Gunakan filter Hostgroup, Servicegroup, State, Sort, atau aktifkan tombol <b>Grouped</b> agar service dikelompokkan per host.',
          '<b>Problems (Active / Downtimes):</b> Menampilkan khusus objek bermasalah (default <i>All Problems</i>). Filter di Problems terpisah dari Inventory sehingga tidak saling menimpa.',
          '<b>Detail Drawer:</b> Klik baris host/service untuk melihat output lengkap, <i>Performance Data</i>, latency, serta tombol lintas-menu (<b>View SLA Report</b>, <b>Edit Config</b>, <b>+ Add Service</b>).',
          '<b>Bulk Actions (Multi-Select):</b> Centang beberapa baris sekaligus → muncul bar aksi untuk <b>Force Check All</b>, <b>Acknowledge All</b>, atau <b>Schedule Downtime</b> dalam 1 aksi.'
        ]
      },
      {
        title: '3. Reports — SLA Availability, Charts & Export PDF/CSV',
        nav: "setView('reports','sla')",
        steps: [
          '<b>Rentang Waktu:</b> Pilih preset <b>24h</b>, <b>7d</b>, <b>30d</b>, atau <b>Custom</b> (pilih tanggal awal &amp; akhir).',
          '<b>Filter Granular:</b> Saring laporan berdasarkan <b>Hostgroup → Host → Service</b> tertentu. Aktifkan tombol <b>Grouped</b> untuk melihat rata-rata SLA per host beserta breakdown service-nya.',
          '<b>Visual Charts:</b> Menampilkan <i>State Breakdown Donut</i> dan <i>Uptime &amp; Incident Trend Bar Chart</i> (titik merah menandakan HARD incident).',
          '<b>Export &amp; Digest:</b> Klik <b>CSV</b> untuk olah data di Excel, <b>Print / PDF</b> untuk cetak, atau <b>Schedule Digest</b> untuk kirim laporan SLA otomatis harian/mingguan. Tab <b>Metrics</b> menampilkan grafik time-series <code>perf_data</code>, sementara <b>Alerts</b> &amp; <b>Event Log</b> menampilkan riwayat log Encore lengkap.'
        ]
      },
      {
        title: '4. Manage → Hosts & Services — CRUD, Diff Highlight & Discard',
        nav: "setView('manage','objects')",
        steps: [
          '<b>Search &amp; Accordion:</b> Cari host, IP, service, atau command secara instan. Secara default service dikelompokkan di dalam accordion tiap host agar tidak perlu scroll panjang (bisa pindah ke mode <b>Flat</b> kapan saja).',
          '<b>Clone &amp; Bulk Delete:</b> Gunakan <b>Clone</b> untuk menduplikasi host beserta seluruh service-nya. Centang banyak host atau banyak service untuk <b>Enable / Disable / Delete</b> sekaligus dengan dialog konfirmasi modern.',
          '<b>Visual Diff &amp; Discard:</b> Setiap perubahan baru ditandai badge <b>NEW</b> (hijau) atau <b>MODIFIED</b> (kuning). Klik <b>Review Changes</b> di banner atas untuk melihat daftar lengkap perubahan, klik <b>Discard</b> untuk membatalkan semua draft, atau <b>Validate → Apply &amp; Reload</b> untuk mengaktifkan.'
        ]
      },
      {
        title: '5. Manage → Templates — Paket Check Reusable',
        nav: "setView('manage','templates')",
        steps: [
          '<b>Starter Templates:</b> Tersedia template siap pakai seperti <code>linux-ncpa-basic</code>, <code>windows-ncpa-basic</code>, dan <code>web-https-stack</code>.',
          '<b>Save From Host:</b> Sudah punya 1 host dengan konfigurasi service sempurna? Klik <b>Save From Host</b> untuk menyimpannya menjadi template baru dalam 1 klik.',
          '<b>Apply Template:</b> Terapkan 1 template ke 1 atau banyak host sekaligus (service yang sudah ada dilewati otomatis kecuali Anda centang <i>Overwrite</i>). Anda juga bisa langsung memilih template saat <b>+ Add Host</b>.'
        ]
      },
      {
        title: '6. Manage → Commands, Custom Scripts, Groups & Secrets',
        nav: "setView('manage','commands')",
        steps: [
          '<b>Autocomplete Command:</b> Saat menambah service, kolom <i>Check Command</i> otomatis menyarankan command aktif dan memberi peringatan jika nama command belum terdaftar.',
          '<b>Custom Scripts:</b> Tulis plugin Bash atau Python langsung di browser, otomatis <code>chmod +x</code>, uji langsung dengan tombol <b>Test</b>, lalu klik <b>+ Cmd</b> untuk mendaftarkannya.',
          '<b>Secrets (<code>$USER2$..$USER32$</code>):</b> Simpan token/password sensitif (seperti token NCPA) di tab <b>Secrets</b> agar tidak tampil plaintext di daftar command.'
        ]
      },
      {
        title: '7. System — Engine Controls, Auto-Backup & Audit Log',
        nav: "setView('system','controls')",
        steps: [
          '<b>Controls:</b> Nyalakan/matikan global Notifications, Service Checks, Host Checks, Flap Detection, atau inspeksi raw <code>localhost.cfg</code>.',
          '<b>Backups &amp; 1-Click Rollback:</b> Setiap kali <i>Apply &amp; Reload</i> berhasil, Encore menyimpan snapshot JSON otomatis (maks. 10 versi terakhir). Klik <b>Rollback</b> untuk kembali ke versi sebelumnya kapan saja.',
          '<b>Audit Log:</b> Mencatat seluruh aktivitas perubahan konfigurasi, external command, discard, dan pengiriman notifikasi.'
        ]
      }
    ].filter(s => guideMatches(q, s.title + ' ' + s.steps.join(' ')));

    el.innerHTML = sections.length ? sections.map(s => `
      <div class="guide-card">
        <div class="guide-card-head">
          <h3>${s.title}</h3>
          <button class="btn btn-sm" onclick="${s.nav}">Open Menu ›</button>
        </div>
        <ol class="guide-steps">${s.steps.map(st => `<li>${st}</li>`).join('')}</ol>
      </div>`).join('') : '<div class="empty">No guide sections match your filter.</div>';
  } else if (S.guideTab === 'ncpa') {
    const snippet = ncpaInstallSnippet(S.ncpaOS);
    const verifyCmd = `curl -sk "https://IP_TARGET:5693/api/cpu/percent?token=TOKEN_ANDA"`;
    el.innerHTML = `
      <div class="cards-3">
        <div class="step-card"><div class="step-num">1</div><h4>Install NCPA di Target</h4><p>Jalankan perintah instalasi sesuai OS target di bawah, set <code class="code-chip">community_string</code>, dan buka port <code class="code-chip">5693/tcp</code> khusus dari IP Encore.</p></div>
        <div class="step-card"><div class="step-num">2</div><h4>Simpan Token di Secrets</h4><p>Buka <b>Manage → Secrets</b>, simpan token ke <code class="code-chip">$USER2$</code> agar tidak tampil plaintext di UI.</p>
          <div style="margin-top:8px"><button class="btn btn-sm" onclick="setView('manage','secrets')">Open Secrets ›</button></div>
        </div>
        <div class="step-card"><div class="step-num">3</div><h4>Register &amp; Apply Template</h4><p>Klik <b>+ Register check_ncpa</b> (in-process Go Fast Worker), lalu apply template <b>linux-ncpa-basic</b> / <b>windows-ncpa-basic</b> ke host target.</p>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-sm primary" onclick="quickRegisterNCPA()">+ Register check_ncpa</button>
            <button class="btn btn-sm" onclick="setView('manage','templates')">Templates ›</button>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Quick Install NCPA di Server Target</div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm ${S.ncpaOS==='ubuntu'?'active':''}" onclick="setNcpaOS('ubuntu')">Ubuntu / Debian</button>
            <button class="btn btn-sm ${S.ncpaOS==='rhel'?'active':''}" onclick="setNcpaOS('rhel')">RHEL / Rocky</button>
            <button class="btn btn-sm ${S.ncpaOS==='windows'?'active':''}" onclick="setNcpaOS('windows')">Windows</button>
          </div>
        </div>
        <div style="padding:14px 16px">
          <div class="code-block-wrap">
            <button class="btn btn-sm code-copy-btn" onclick="copyText(ncpaInstallSnippet(S.ncpaOS))">Copy</button>
            <pre class="guide-pre">${esc(snippet)}</pre>
          </div>
          <div class="name-primary" style="margin:12px 0 6px;font-size:13px">Verifikasi dari Server Encore</div>
          <div class="code-block-wrap">
            <button class="btn btn-sm code-copy-btn" onclick="copyText('${esc(verifyCmd)}')">Copy</button>
            <pre class="guide-pre">${esc(verifyCmd)}</pre>
          </div>
          <div class="name-primary" style="margin:12px 0 6px;font-size:13px">Daftar Metrik NCPA Populer (menggunakan <code class="code-chip">$USER2$</code>)</div>
          <pre class="guide-pre">CPU Usage        check_ncpa!cpu/percent!-w 80 -c 90
Memory RAM       check_ncpa!memory/virtual!-w 80 -c 90
Swap Usage       check_ncpa!memory/swap!-w 50 -c 80
Disk / (Linux)   check_ncpa!disk/logical/|/used_percent!-w 80 -c 90
Disk C: (Win)    check_ncpa!disk/logical/C:|/used_percent!-w 80 -c 90
Process Count    check_ncpa!processes!-w 250 -c 400
Service Status   check_ncpa!services!-q service=nginx,status=running</pre>
        </div>
      </div>`;
  } else if (S.guideTab === 'notify') {
    el.innerHTML = `
      <div class="guide-card">
        <div class="guide-card-head">
          <h3>Setup Email Notification (Built-in SMTP — Tanpa Postfix)</h3>
          <button class="btn btn-sm primary" onclick="setView('manage','notifications')">Open Notifications ›</button>
        </div>
        <ol class="guide-steps">
          <li>Buka <b>Manage → Notifications</b>, aktifkan checkbox <b>Enable Email</b>.</li>
          <li>Isi <b>SMTP Host &amp; Port</b>:
            <br>• <b>Gmail / Google Workspace:</b> Host <code>smtp.gmail.com</code>, Port <code>587</code> (STARTTLS), gunakan <b>App Password</b> (bukan password login biasa).
            <br>• <b>Microsoft 365:</b> Host <code>smtp.office365.com</code>, Port <code>587</code> (STARTTLS).
            <br>• <b>SMTP Relay Internal:</b> Port <code>25</code> (Plain) atau <code>587</code> (STARTTLS).</li>
          <li>Isi <b>From Address</b> dan <b>Recipients</b> (pisahkan dengan koma). Jika <i>Include Manage Contacts</i> dicentang, email di tab <b>Groups → Contacts</b> otomatis ikut menerima alert.</li>
          <li>Biarkan <b>HARD State Only</b> aktif agar tidak terkena spam saat <i>SOFT retry</i>, atur <b>Cooldown</b> (default 10 menit), lalu klik <b>Save &amp; Activate</b> (berlaku langsung tanpa reload Encore Engine) dan klik <b>Send Test Email</b>.</li>
        </ol>
      </div>
      <div class="guide-card">
        <div class="guide-card-head"><h3>Setup Webhook (Telegram / Slack / Discord)</h3></div>
        <ol class="guide-steps">
          <li><b>Telegram Bot:</b> Buat bot lewat <code>@BotFather</code> untuk mendapat <code>BOT_TOKEN</code>. Masukkan bot ke grup alert, lalu ambil <code>chat_id</code> (biasanya berawalan <code>-100...</code>). Isi URL: <code>https://api.telegram.org/bot&lt;BOT_TOKEN&gt;/sendMessage</code> dan isi kolom <b>Telegram Chat ID</b>.</li>
          <li><b>Slack:</b> Buat <i>Incoming Webhook</i> di Slack App → tempel URL <code>https://hooks.slack.com/services/...</code> dan pilih tipe <b>Slack</b>.</li>
          <li><b>Discord:</b> Buka <i>Server Settings → Integrations → Webhooks</i> → tempel URL webhook dan pilih tipe <b>Discord</b>.</li>
          <li>Klik <b>Save &amp; Activate</b> lalu <b>Send Test Webhook</b>, dan pantau status pengiriman di tabel <b>Recent Delivery Log</b>.</li>
        </ol>
      </div>`;
  } else if (S.guideTab === 'catalog') {
    const drawCatalog = pData => {
      el.innerHTML = `
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Active Commands (${S.catalogCmds.length})</div>
            <input type="search" id="cat-search" value="${esc(q)}" placeholder="Filter command..." oninput="filterCatalog()">
          </div>
          <div class="table-wrap"><table><thead><tr><th>Command</th><th>Source</th><th>Example</th><th>Command Line</th><th style="text-align:right">Copy</th></tr></thead><tbody id="cat-cmd-body"></tbody></table></div>
        </div>
        <div class="panel" style="padding:14px 16px">
          <div class="name-primary" style="margin-bottom:6px">Plugins (${(pData.plugins||[]).length}) — <span class="mono">${esc(pData.user1_dir||'')}</span></div>
          <div class="perf-chips">${(pData.plugins||[]).slice(0,80).map(p => `<span class="perf-chip" title="${esc(p.path)}" style="${p.is_custom?'background:var(--ok-bg);color:var(--ok-fg)':''}">${esc(p.name)}</span>`).join('')}</div>
        </div>`;
      filterCatalog();
    };
    if (S.catalogCmds.length && S._catalogPlugins) {
      drawCatalog(S._catalogPlugins);
      return;
    }
    el.innerHTML = '<div class="panel"><div class="empty"><encore-icon name="loader" size="2" live></encore-icon> Loading catalog...</div></div>';
    const [cRes, pRes] = await Promise.all([fetch('/api/v1/catalog/commands'), fetch('/api/v1/catalog/plugins')]);
    S.catalogCmds = (await cRes.json()).commands || [];
    S._catalogPlugins = await pRes.json();
    drawCatalog(S._catalogPlugins);
  } else {
    const p = await (await fetch('/api/v1/catalog/paths')).json();
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Server File Locations</div></div>
        <div class="table-wrap"><table><thead><tr><th>Component</th><th>Path</th></tr></thead><tbody>
          <tr><td><b>Main Config</b></td><td class="mono">${esc(p.nagios_cfg)}</td></tr>
          <tr><td><b>Managed Dir</b></td><td class="mono">${esc(p.managed_dir||'-')}</td></tr>
          <tr><td><b>Custom Scripts</b></td><td class="mono">${esc(p.scripts_dir||'-')}</td></tr>
          <tr><td><b>Backups</b></td><td class="mono">${esc(p.backups_dir||'-')}</td></tr>
          <tr><td><b>Audit Log</b></td><td class="mono">${esc(p.audit_log||'-')}</td></tr>
          <tr><td><b>Secrets / Resource</b></td><td class="mono">${esc(p.resource_cfg)}</td></tr>
          <tr><td><b>Plugins ($USER1$)</b></td><td class="mono">${esc(p.plugins_dir)}</td></tr>
          <tr><td><b>Localhost Config</b></td><td class="mono">${esc(p.localhost_cfg)}</td></tr>
        </tbody></table></div>
      </div>
      <div class="guide-card">
        <div class="guide-card-head"><h3>Troubleshooting Cepat (FAQ)</h3></div>
        <ol class="guide-steps">
          <li><b>Error <code>command '...' not defined anywhere</code> saat Validate:</b> Command belum terdaftar di Encore Engine. Untuk NCPA, buka <b>Guide → NCPA Setup</b> lalu klik <b>+ Register check_ncpa</b>.</li>
          <li><b>Lupa sudah ubah apa saja / ingin batal edit:</b> Klik <b>Review Changes</b> di banner kuning atas, lalu klik <b>Discard</b> untuk kembali ke konfigurasi live terakhir.</li>
          <li><b>Salah konfigurasi setelah Apply:</b> Buka <b>System → Backups</b> dan klik <b>Rollback</b> pada snapshot sebelum perubahan.</li>
          <li><b>Healthcheck aman untuk monitoring Encore sendiri:</b> Gunakan endpoint publik <code>GET /healthz</code> (bebas auth, mengembalikan <code>200 ok</code> atau <code>503 degraded</code> tanpa bocor metadata). Contoh command: <code>check_http!-p 8080 -u /healthz</code>.</li>
          <li><b>Cek Kadaluarsa Sertifikat SSL (In-Process):</b> Gunakan preset <b>SSL Cert</b> (<code>check_http!-S -C 30,14</code>) untuk peringatan 30 hari &amp; kritis 14 hari sebelum sertifikat HTTPS expired.</li>
        </ol>
      </div>`;
  }
}

function filterCatalog() {
  const q = (document.getElementById('cat-search')?.value || '').toLowerCase();
  const body = document.getElementById('cat-cmd-body'); if (!body) return;
  const rows = S.catalogCmds.filter(c => !q || c.command_name.toLowerCase().includes(q) || c.command_line.toLowerCase().includes(q));
  body.innerHTML = rows.length ? rows.map(c => `<tr>
    <td><b>${esc(c.command_name)}</b>${c.fast_path?' <span class="badge c-ok">Go Fast</span>':''}</td>
    <td><span class="flag-tag">${esc(c.source)}</span></td>
    <td class="mono">${esc(c.example)}</td>
    <td class="output-cell mono" title="${esc(c.command_line)}">${esc(c.command_line)}</td>
    <td class="actions"><button class="btn btn-sm" onclick="copyText('${esc(c.example)}')">Copy</button></td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty">No matches</td></tr>';
}
