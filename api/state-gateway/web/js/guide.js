function setGuideTab(t) {
  S.guideTab = t;
  ['quick','ncpa','catalog','paths'].forEach(k => document.getElementById('gtab-'+k)?.classList.toggle('active', k===t));
  renderGuide();
}

async function renderGuide() {
  const el = document.getElementById('guide-content');
  if (S.guideTab === 'quick') {
    el.innerHTML = `
      <div class="cards-3">
        <div class="step-card"><div class="step-num">1</div><h4>Monitor & Triage</h4><p>Cek <b>Overview</b> & <b>Problems</b>. Klik baris untuk buka detail, lalu <b>↻ Force Check</b>, <b>✓ ACK</b>, atau <b>⏱ Downtime</b>.</p></div>
        <div class="step-card"><div class="step-num">2</div><h4>Manage & Clone</h4><p>Buka <b>Manage</b> untuk tambah/edit Host, Service, Localhost, Command, atau <b>Clone Host</b> beserta seluruh service-nya.</p></div>
        <div class="step-card"><div class="step-num">3</div><h4>Validate & Reload</h4><p>Klik <b>Validate</b> lalu <b>Apply & Reload</b>. Backup dibuat otomatis di <b>System → Backups</b> (1-click rollback).</p></div>
      </div>
      <div class="panel" style="padding:16px">
        <div class="kv-grid" style="margin:0">
          <div class="kv-box"><div class="k">Status</div><div class="v" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <span class="badge c-ok"><img src="/assets/status/status-ok.svg">UP / OK (0)</span>
            <span class="badge c-warn"><img src="/assets/status/status-warn.svg">WARN (1)</span>
            <span class="badge c-crit"><img src="/assets/status/status-critical.svg">CRIT / DOWN (2)</span>
            <span class="badge c-unk"><img src="/assets/status/status-info.svg">UNK (3)</span>
          </div></div>
          <div class="kv-box"><div class="k">Shortcuts & Flags</div><div class="v" style="font-size:12.5px;font-weight:500;margin-top:6px;color:var(--muted)">
            <code class="code-chip">/</code> Search • <code class="code-chip">Esc</code> Close • <span class="flag-tag">ACK</span> <span class="flag-tag">DT</span> <span class="flag-tag">SOFT</span> <span class="flag-tag">FLAP</span>
          </div></div>
        </div>
      </div>`;
  } else if (S.guideTab === 'ncpa') {
    el.innerHTML = `
      <div class="cards-3">
        <div class="step-card"><div class="step-num">1</div><h4>Install NCPA di Target</h4><p>Install paket <b>ncpa</b>, set <code class="code-chip">community_string</code> di <code class="code-chip">ncpa.cfg</code>, buka port <code class="code-chip">5693/tcp</code>.</p></div>
        <div class="step-card"><div class="step-num">2</div><h4>Simpan Token di Secrets</h4><p>Buka <b>Manage → Secrets</b>, simpan token ke <code class="code-chip">$USER2$</code> agar tidak tampil plaintext di UI.</p>
          <div style="margin-top:8px"><button class="btn btn-sm" onclick="setView('manage','secrets')">Open Secrets ›</button></div>
        </div>
        <div class="step-card"><div class="step-num">3</div><h4>Register & Pakai Preset</h4><p>Daftarkan command <code class="code-chip">check_ncpa</code> (in-process di Go Worker), lalu pilih Preset NCPA saat + Add Service.</p>
          <div style="margin-top:8px"><button class="btn btn-sm primary" onclick="quickRegisterNCPA()">+ Register check_ncpa</button></div>
        </div>
      </div>
      <div class="panel" style="padding:16px">
        <div class="name-primary" style="margin-bottom:6px">Contoh Service Check Command (menggunakan <code class="code-chip">$USER2$</code>)</div>
        <pre class="guide-pre">CPU     check_ncpa!cpu/percent!-w 80 -c 90
Memory  check_ncpa!memory/virtual!-w 80 -c 90
Disk /  check_ncpa!disk/logical/|/used_percent!-w 80 -c 90
Procs   check_ncpa!processes!-w 250 -c 400</pre>
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
