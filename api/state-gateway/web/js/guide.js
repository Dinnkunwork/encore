function setGuideTab(t) {
  S.guideTab = t;
  ['quick','ncpa','catalog','paths'].forEach(k => document.getElementById('gtab-'+k)?.classList.toggle('active', k===t));
  renderGuide();
}

function setNcpaOS(os) {
  S.ncpaOS = os;
  renderGuide();
}

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

async function renderGuide() {
  const el = document.getElementById('guide-content');
  if (S.guideTab === 'quick') {
    el.innerHTML = `
      <div class="cards-3">
        <div class="step-card"><div class="step-num">1</div><h4>Monitor &amp; Bulk Triage</h4><p>Cek <b>Overview</b> &amp; <b>Problems</b>. Centang banyak baris untuk <b>Force Check / ACK / Downtime</b> sekaligus, atau tekan <code class="code-chip">Ctrl+K</code> untuk Quick Jump.</p></div>
        <div class="step-card"><div class="step-num">2</div><h4>Manage &amp; Templates</h4><p>Gunakan <b>Manage → Templates</b> untuk menerapkan paket check (mis. <i>Linux NCPA Basic</i>) ke banyak host sekaligus tanpa input ulang.</p></div>
        <div class="step-card"><div class="step-num">3</div><h4>Alerts &amp; SLA Reports</h4><p>Aktifkan email SMTP / Webhook di <b>Manage → Notifications</b> dan pantau grafik SLA + Export PDF di <b>Reports</b>.</p></div>
      </div>
      <div class="panel" style="padding:16px">
        <div class="kv-grid" style="margin:0">
          <div class="kv-box"><div class="k">Status</div><div class="v" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <span class="badge c-ok"><img src="/assets/status/status-ok.svg">UP / OK (0)</span>
            <span class="badge c-warn"><img src="/assets/status/status-warn.svg">WARN (1)</span>
            <span class="badge c-crit"><img src="/assets/status/status-critical.svg">CRIT / DOWN (2)</span>
            <span class="badge c-unk"><img src="/assets/status/status-info.svg">UNK (3)</span>
          </div></div>
          <div class="kv-box"><div class="k">Shortcuts &amp; Flags</div><div class="v" style="font-size:12.5px;font-weight:500;margin-top:6px;color:var(--muted)">
            <code class="code-chip">Ctrl+K</code> Quick Jump • <code class="code-chip">/</code> Search • <code class="code-chip">Esc</code> Close • <span class="flag-tag">ACK</span> <span class="flag-tag">DT</span> <span class="flag-tag">SOFT</span> <span class="flag-tag">FLAP</span>
          </div></div>
        </div>
      </div>`;
  } else if (S.guideTab === 'ncpa') {
    const snippet = ncpaInstallSnippet(S.ncpaOS);
    const verifyCmd = `curl -sk "https://IP_TARGET:5693/api/cpu/percent?token=TOKEN_ANDA"`;
    el.innerHTML = `
      <div class="cards-3">
        <div class="step-card"><div class="step-num">1</div><h4>Install NCPA di Target</h4><p>Ikuti quick install di bawah sesuai OS target, lalu samakan <code class="code-chip">community_string</code> dan buka port <code class="code-chip">5693/tcp</code>.</p></div>
        <div class="step-card"><div class="step-num">2</div><h4>Simpan Token di Secrets</h4><p>Buka <b>Manage → Secrets</b>, simpan token ke <code class="code-chip">$USER2$</code> agar tidak tampil plaintext di UI.</p>
          <div style="margin-top:8px"><button class="btn btn-sm" onclick="setView('manage','secrets')">Open Secrets ›</button></div>
        </div>
        <div class="step-card"><div class="step-num">3</div><h4>Register &amp; Apply Template</h4><p>Daftarkan command <code class="code-chip">check_ncpa</code> (in-process Go Worker), lalu terapkan template <b>linux-ncpa-basic</b> ke host Anda.</p>
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
          <div class="name-primary" style="margin:12px 0 6px;font-size:13px">Contoh Service Check Command (<code class="code-chip">$USER2$</code>)</div>
          <pre class="guide-pre">CPU     check_ncpa!cpu/percent!-w 80 -c 90
Memory  check_ncpa!memory/virtual!-w 80 -c 90
Disk /  check_ncpa!disk/logical/|/used_percent!-w 80 -c 90
Procs   check_ncpa!processes!-w 250 -c 400</pre>
        </div>
      </div>`;
  } else if (S.guideTab === 'catalog') {
    el.innerHTML = '<div class="panel"><div class="empty">Loading catalog...</div></div>';
    const [cRes, pRes] = await Promise.all([fetch('/api/v1/catalog/commands'), fetch('/api/v1/catalog/plugins')]);
    S.catalogCmds = (await cRes.json()).commands || [];
    const pData = await pRes.json();
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Active Commands (${S.catalogCmds.length})</div>
          <input type="search" id="cat-search" placeholder="Filter command..." oninput="filterCatalog()">
        </div>
        <div class="table-wrap"><table><thead><tr><th>Command</th><th>Source</th><th>Example</th><th>Command Line</th><th style="text-align:right">Copy</th></tr></thead><tbody id="cat-cmd-body"></tbody></table></div>
      </div>
      <div class="panel" style="padding:14px 16px">
        <div class="name-primary" style="margin-bottom:6px">Plugins (${(pData.plugins||[]).length}) — <span class="mono">${esc(pData.user1_dir)}</span></div>
        <div class="perf-chips">${(pData.plugins||[]).slice(0,80).map(p => `<span class="perf-chip" title="${esc(p.path)}" style="${p.is_custom?'background:var(--ok-bg);color:var(--ok-fg)':''}">${esc(p.name)}</span>`).join('')}</div>
      </div>`;
    filterCatalog();
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
