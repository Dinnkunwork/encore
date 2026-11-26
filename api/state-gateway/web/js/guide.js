/* ==========================================================================
   ENCORE CONTROL ROOM — USER GUIDE (READ MODE)
   Cross-tab search, RBAC-aware actions, interactive NCPA generator, live catalog
   ========================================================================== */

let _guidePathsCache = null;
let _guidePluginsCache = null;
let _guideNcpaToken = '';
let _guideNcpaServer = (typeof location !== 'undefined' && location.hostname && location.hostname !== 'localhost') ? location.hostname : 'ENCORE_SERVER_IP';

function setGuideTab(t, skipHash) {
  S.guideTab = t;
  ['quick','menus','ncpa','notify','catalog','paths'].forEach(k => {
    const btn = document.getElementById('gtab-' + k);
    if (btn) {
      btn.classList.toggle('active', k === t);
      btn.setAttribute('aria-selected', k === t ? 'true' : 'false');
    }
  });
  if (!skipHash && typeof syncHashFromState === 'function') syncHashFromState();
  renderGuide();
}

function setNcpaOS(os) {
  S.ncpaOS = os;
  renderGuide();
}

function updateNcpaVar(kind, val) {
  const clean = String(val || '').trim();
  if (kind === 'token') _guideNcpaToken = clean;
  else _guideNcpaServer = clean || 'ENCORE_SERVER_IP';
  const pre = document.getElementById('ncpa-install-pre');
  if (pre) pre.textContent = ncpaInstallSnippet(S.ncpaOS);
  const verPre = document.getElementById('ncpa-verify-pre');
  if (verPre) verPre.textContent = ncpaVerifySnippet();
}

function ncpaTokenVal() { return _guideNcpaToken || 'YOUR_NCPA_TOKEN'; }
function ncpaServerVal() { return _guideNcpaServer || 'ENCORE_SERVER_IP'; }

function ncpaInstallSnippet(os) {
  const tok = ncpaTokenVal();
  const srv = ncpaServerVal();
  if (os === 'rhel') {
    return `# 1. Add official Nagios repo & install NCPA (RHEL/Rocky/Alma 9; use 8 for EL8)
sudo rpm -Uvh https://repo.nagios.com/nagios/9/nagios-repo-9-1.el9.noarch.rpm
sudo dnf install -y ncpa

# 2. Set community_string (must match $USER2$ in Manage -> Secrets)
sudo sed -i 's/^community_string = .*/community_string = ${tok}/' /usr/local/ncpa/etc/ncpa.cfg
sudo systemctl enable --now ncpa

# 3. Allow port 5693/tcp ONLY from the Encore server
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${srv}" port port="5693" protocol="tcp" accept'
sudo firewall-cmd --reload`;
  }
  if (os === 'windows') {
    return `# 1. Download the NCPA Windows installer (.exe) from https://www.nagios.org/ncpa/#downloads
# 2. Run the wizard -> set Token (${tok}) -> Port 5693 -> Finish
# 3. (Optional Admin PowerShell) Restrict port 5693 to the Encore server only:
New-NetFirewallRule -DisplayName "Encore NCPA 5693" -Direction Inbound -Protocol TCP -LocalPort 5693 -RemoteAddress ${srv} -Action Allow`;
  }
  return `# 1. Add official Nagios repo & install NCPA (Ubuntu / Debian)
curl -sSL https://repo.nagios.com/GPG-KEY-NAGIOS-V3 | sudo gpg --dearmor -o /usr/share/keyrings/nagios.gpg
echo "deb [signed-by=/usr/share/keyrings/nagios.gpg] https://repo.nagios.com/deb/$(lsb_release -cs) /" | sudo tee /etc/apt/sources.list.d/nagios.list
sudo apt update && sudo apt install -y ncpa

# 2. Set community_string (must match $USER2$ in Manage -> Secrets)
sudo sed -i 's/^community_string = .*/community_string = ${tok}/' /usr/local/ncpa/etc/ncpa.cfg
sudo systemctl enable --now ncpa

# 3. Allow port 5693/tcp ONLY from the Encore server
sudo ufw allow from ${srv} to any port 5693 proto tcp`;
}

function ncpaVerifySnippet() {
  return `curl -k "https://TARGET_HOST_IP:5693/api/cpu/percent?token=${ncpaTokenVal()}"`;
}

/* Safe Copy Helper with Inline Feedback (avoids inline JS string quoting bugs) */
function copyGuideBtn(btn, textOverride) {
  const txt = typeof textOverride === 'string'
    ? textOverride
    : (btn?.dataset?.copy ?? btn?.closest('.code-block-wrap')?.querySelector('pre')?.textContent ?? '');
  copyText(txt);
  if (btn) {
    const prev = btn.dataset.origLabel || btn.innerHTML;
    btn.dataset.origLabel = prev;
    btn.innerHTML = `${uiIcon('check')} Copied`;
    btn.classList.add('active');
    clearTimeout(btn._cpTimer);
    btn._cpTimer = setTimeout(() => {
      btn.innerHTML = prev;
      btn.classList.remove('active');
    }, 1500);
  }
}

function guideAdminCTA(label, onClickJS, cls = 'btn btn-sm') {
  if (!isAdmin()) return `<span class="flag-tag" title="Requires Admin role">Admin Only</span>`;
  return `<button type="button" class="${cls}" onclick="${onClickJS}">${label}</button>`;
}

function guideMenuSections() {
  return [
    {
      tab: 'menus', id: 'overview',
      title: '1. Overview — Executive Control Room',
      action: `<button type="button" class="btn btn-sm" onclick="setView('overview')">Open Overview</button>`,
      items: [
        '<b>Operational Readiness Banner:</b> Distinguishes <i>Fleet Nominal</i> (green), <i>Active Warning</i> (amber — no critical outages), and <i>Active Incident</i> (red) so warnings never masquerade as critical outages.',
        '<b>4 Chronograph KPI Cards:</b> Clickable summary metrics for <b>01 / Host Health</b>, <b>02 / Service Health</b>, <b>03 / Unhandled</b>, and <b>04 / 24h Service SLA</b>.',
        '<b>Customizable 12-Column Layout:</b> Click <b>Layout</b> (or <b>Display → Overview Layout → Customize</b>) to drag-and-drop widgets, reorder with <b>↑/↓</b> keyboard buttons, cycle width (<b>5 / 6 / 7 / 12</b>), hide/restore widgets, or toggle <b>Auto-pin Problems</b>. Saved in browser storage.',
        '<b>Fleet Health Map &amp; Radial Topology:</b> Switch between <b>Health Grid</b> (with 24 Host OS/Device icons) and interactive <b>Radial Topology</b> (persisted across reloads).',
        '<b>Distribution, 24h Uptime &amp; Live Metrics (6h):</b> Severity-accurate stacked uptime trend plus an inline 6-hour performance metric widget directly on Overview.',
        '<b>Unhandled Problems (Hosts &amp; Services):</b> Displays both unhandled DOWN/UNREACHABLE hosts and critical/warning services with inline Force Check and Acknowledge actions.'
      ]
    },
    {
      tab: 'menus', id: 'inventory',
      title: '2. Inventory — By Host, Services, Hosts & Groups',
      action: `<button type="button" class="btn btn-sm" onclick="setView('inventory','byhost')">Open Inventory</button>`,
      items: [
        '<b>By Host (Default):</b> Accordion view grouping each host with its OS/device icon, health bar, hostgroups, and all monitored services.',
        '<b>Services &amp; Hosts Views:</b> Filter by Hostgroup, Servicegroup, State, Sort order, or <b>Unhandled</b> toggle using sleek theme-matched dropdowns and checkboxes.',
        '<b>Slide-Over Detail Drawer:</b> Click any host or service row to inspect live <code>plugin_output</code>, performance chips, 6h metric trends, and inline <b>Acknowledge</b> / <b>Downtime</b> forms.',
        '<b>Bulk Operations:</b> Select multiple rows to Force Check, Acknowledge, or schedule Downtime in a single batch.'
      ]
    },
    {
      tab: 'menus', id: 'problems',
      title: '3. Problems — Active Triage & Downtimes',
      action: `<button type="button" class="btn btn-sm" onclick="setView('problems','active')">Open Problems</button>`,
      items: [
        '<b>Active Queue:</b> Automatically filters non-OK services sorted by severity (CRITICAL first, then WARNING/UNKNOWN).',
        '<b>Scheduled &amp; Recurring Downtimes:</b> Inspect active maintenance windows, cancel with confirmation, or define recurring weekly maintenance schedules.',
        '<b>Alert Chime &amp; TV Mode:</b> Enable real-time Web Audio HARD-alert chime or launch fullscreen NOC Wallboard via <b>Display</b> or <code>Shift+T</code>.'
      ]
    },
    {
      tab: 'menus', id: 'reports',
      title: '4. Reports — SLA, Stacked Trends, Metrics & Digest',
      action: `<button type="button" class="btn btn-sm" onclick="setView('reports','sla')">Open Reports</button>`,
      items: [
        '<b>Severity-Accurate Stacked Uptime Trend:</b> Hourly/daily stacked bars show <b>OK</b> (green), <b>Warn</b> (amber), and <b>Crit</b> (red only when critical outage occurred). Solid red dots mark critical HARD incidents; amber rings mark warning transitions.',
        '<b>Interactive Metrics:</b> Time-series SVG area/line charts with crosshair hover tooltips and WARN/CRIT threshold dashed lines.',
        '<b>Alerts &amp; Event Log:</b> Search historical alert transitions (with HARD-only filter) and notification history.',
        '<b>Scheduled SLA Digest &amp; Export:</b> Automate daily/weekly SLA summaries via Email/Webhook, or export filtered reports to <b>CSV</b> and <b>Print / PDF</b>.'
      ]
    },
    {
      tab: 'menus', id: 'manage',
      title: '5. Manage — Configuration, Host Icons, Discovery & RBAC',
      action: guideAdminCTA('Open Manage', "setView('manage','objects')"),
      items: [
        '<b>Hosts &amp; Services + 24 Host OS Icons:</b> Create, edit, clone, and bulk-edit hosts with a visual <b>24-Icon OS &amp; Device Picker</b> (Linux, Windows, Ubuntu, Debian, RHEL, Proxmox, VMware, Docker, K8s, MikroTik, Cisco, Synology, Firewall, etc. + Auto-detect).',
        '<b>Templates &amp; Network Discovery:</b> Apply reusable service bundles (Linux NCPA, Windows, Web/SSL) to multiple hosts, or scan CIDR subnets to onboard live hosts safely.',
        '<b>Commands, Scripts &amp; Secrets:</b> Define check commands, manage custom plugins in <code>$USER1$</code>, and store sensitive tokens/passwords in <code>$USER2$..$USER32$</code>.',
        '<b>Notifications &amp; Users (RBAC):</b> Configure Email SMTP and emoji-formatted Telegram/Discord/Slack/Generic Webhooks, and manage <b>Admin / Operator / Viewer</b> accounts.',
        '<b>Safe Draft Workflow:</b> Review pending changes in <b>Diff Review</b>, run <b>Validate</b> (<code>nagios -v</code>), then click <b>Apply &amp; Reload</b> (with automatic backup).'
      ]
    },
    {
      tab: 'menus', id: 'system',
      title: '6. System — Engine Controls, Backups & Audit',
      action: guideAdminCTA('Open System', "setView('system','controls')"),
      items: [
        '<b>Controls:</b> Toggle global Active Checks, Notifications, Event Handlers, and Flap Detection.',
        '<b>Backups &amp; 1-Click Rollback:</b> Every <i>Apply &amp; Reload</i> snapshots the previous config for instant one-click recovery.',
        '<b>Audit Log:</b> Chronological trail of every administrative mutation and configuration deployment.'
      ]
    }
  ];
}

function ncpaMetricRows() {
  return [
    { name: 'CPU Usage (%)', cmd: 'check_ncpa!cpu/percent!-w 80 -c 95' },
    { name: 'RAM Usage (%)', cmd: 'check_ncpa!memory/virtual/percent!-w 80 -c 90' },
    { name: 'Linux Root Disk (/)', cmd: 'check_ncpa!disk/logical/|/used_percent!-w 80 -c 90' },
    { name: 'Windows C: Drive', cmd: 'check_ncpa!disk/logical/C:|/used_percent!-w 80 -c 90' },
    { name: 'Systemd / Win Service', cmd: 'check_ncpa!services!-q service=nginx,status=running' },
    { name: 'SSL Cert Expiry (Go)', cmd: 'check_http!-H $HOSTADDRESS$ -S -C 30,14' }
  ];
}

function guideFaqItems() {
  return [
    { q: 'Why did Apply & Reload fail validation?', a: 'Check the exact line reported in the Validate console (for example, a missing command or hostgroup name). Fix the object or click <b>Discard</b> in the yellow Draft banner to revert all staged edits safely.' },
    { q: 'I made a mistake after Apply & Reload — how do I roll back?', a: 'Open <b>System → Backups</b> and click <b>Restore</b> on the previous snapshot. Encore automatically validates and reloads the restored configuration.' },
    { q: 'How do I verify Encore Gateway health from CLI or Nginx?', a: 'Query <code>GET /health</code> or <code>GET /healthz</code> on the gateway port to confirm engine socket connectivity, applied event count, and pending config state.' },
    { q: 'Why does a warning-only host not turn red on Overview?', a: 'By design, Encore reserves red strictly for <b>CRITICAL / DOWN</b> outages. Warning-only states highlight in amber across the Readiness Banner, KPI cards, Stacked Uptime Trend, and Sidebar badge.' },
    { q: 'How do I check SSL certificate expiry?', a: 'Use the built-in in-process Go worker command <code>check_http!-H $HOSTADDRESS$ -S -C 30,14</code> (warns at 30 days, critical at 14 days) with zero external fork overhead.' }
  ];
}

function renderCrossTabSearch(q) {
  const hits = [];
  const pushHit = (tab, tabLabel, title, bodyHTML, searchHay) => {
    if ((title + ' ' + searchHay).toLowerCase().includes(q)) {
      hits.push({ tab, tabLabel, title, bodyHTML });
    }
  };

  pushHit('quick', 'Workflow', 'Architecture & Operator Workflow',
    '<p class="guide-prose">Encore pairs a C monitoring engine, in-process Go workers, and a real-time SSE Control Room with Instant Save, Draft (Apply &amp; Reload), and Auto-Reload scopes.</p>',
    'architecture workflow sse go worker instant save draft apply reload status badges ack dt soft flap ctrl+k shift+t');

  guideMenuSections().forEach(s => {
    const raw = s.items.join(' ');
    pushHit('menus', 'Menus & Features', s.title, `<ul class="guide-steps">${s.items.map(i => `<li>${i}</li>`).join('')}</ul>`, raw);
  });

  ncpaMetricRows().forEach(m => {
    pushHit('ncpa', 'NCPA Setup', `NCPA Metric: ${m.name}`,
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap"><code class="code-chip">${esc(m.cmd)}</code><button type="button" class="btn btn-sm" data-copy="${esc(m.cmd)}" onclick="copyGuideBtn(this)">Copy</button></div>`,
      `ncpa install ubuntu debian rhel rocky windows port 5693 firewall token secret ${m.name} ${m.cmd}`);
  });

  pushHit('notify', 'Notifications', 'Email SMTP & Emoji Webhook Alerts',
    '<p class="guide-prose">Configure SMTP (STARTTLS/SSL, App Password) or Telegram, Discord, Slack, and Generic JSON Webhooks with emoji severity formatting under <b>Manage → Notifications</b>.</p>',
    'email smtp gmail office365 starttls ssl webhook telegram discord slack emoji notification recovery hard only');

  guideFaqItems().forEach(f => {
    pushHit('paths', 'Paths & FAQ', f.q, `<p class="guide-prose">${f.a}</p>`, f.q + ' ' + f.a);
  });

  if (S.catalogCmds && S.catalogCmds.length) {
    S.catalogCmds.forEach(c => {
      if ((c.name + ' ' + c.description + ' ' + c.example).toLowerCase().includes(q)) {
        hits.push({
          tab: 'catalog', tabLabel: 'Catalog', title: `Command: ${c.name}`,
          bodyHTML: `<p class="guide-prose" style="margin-bottom:8px">${esc(c.description)}</p><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap"><code class="code-chip">${esc(c.example)}</code><button type="button" class="btn btn-sm" data-copy="${esc(c.example)}" onclick="copyGuideBtn(this)">Copy</button></div>`
        });
      }
    });
  }

  return `
    <div class="guide-search-banner" role="status" aria-live="polite">
      <span>Found <b>${hits.length}</b> matching topic${hits.length === 1 ? '' : 's'} across all guide tabs for "<b>${esc(q)}</b>"</span>
      <button type="button" class="btn btn-sm" onclick="document.getElementById('guide-search').value='';renderGuide()">Clear Search</button>
    </div>
    ${hits.length ? hits.map(h => `
      <div class="guide-card">
        <div class="guide-card-head">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="flag-tag">${esc(h.tabLabel)}</span>
            <h3>${esc(h.title)}</h3>
          </div>
          <button type="button" class="btn btn-sm" onclick="document.getElementById('guide-search').value='';setGuideTab('${h.tab}')">Open Tab</button>
        </div>
        ${h.bodyHTML}
      </div>`).join('') : `<div class="panel"><div class="art-empty">${artSVG('search')}<h4>No Matching Guide Topics</h4><p>No workflow notes, NCPA snippets, FAQs, or catalog commands matched "${esc(q)}".</p></div></div>`}`;
}

async function renderGuide() {
  const el = document.getElementById('guide-content');
  if (!el) return;
  const q = (document.getElementById('guide-search')?.value || '').trim().toLowerCase();

  if (q && S.guideTab !== 'catalog') {
    el.innerHTML = renderCrossTabSearch(q);
    return;
  }

  if (S.guideTab === 'quick') {
    el.innerHTML = `
      <div class="guide-hero">
        <div class="guide-hero-copy">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
            ${encoreLogoSVG(30, 'brand-svg')}
            <span class="flag-tag" style="background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.22);color:#faf9f5">ENCORE CONTROL ROOM</span>
          </div>
          <h2>Architecture &amp; Operator Workflow</h2>
          <p>Encore combines a C monitoring engine, in-process Go check workers, and a real-time SSE Control Room into one calm operational instrument.</p>
        </div>
        <div class="guide-hero-img"><img src="/assets/scenes/swiss-control-hero.jpg" alt="Encore Control Room Hardware"></div>
      </div>

      <div class="guide-card">
        <div class="guide-card-head"><h2>Core Components</h2></div>
        <div class="cards-3" style="margin-bottom:0">
          <div class="step-card"><div class="step-num">1</div><h4>Encore Core Engine</h4><p>Schedules host/service checks, evaluates HARD/SOFT thresholds, tracks downtimes, and streams state deltas over Query Handler sockets.</p></div>
          <div class="step-card"><div class="step-num">2</div><h4>Go Fast Workers</h4><p>In-process Go executors for <code>check_ping</code>, <code>check_tcp</code>, <code>check_http</code> (including SSL expiry <code>-C</code>), and <code>check_ncpa</code> with zero fork overhead.</p></div>
          <div class="step-card"><div class="step-num">3</div><h4>Encore Control Room</h4><p>Single-binary SSE dashboard with customizable Overview widgets, 24 Host OS icons, SLA analytics, staged config validation, and RBAC.</p></div>
        </div>
      </div>

      <div class="guide-card">
        <div class="guide-card-head"><h2>Configuration Save Scopes</h2></div>
        <div class="cards-3" style="margin-bottom:0">
          <div class="step-card">
            <div style="margin-bottom:8px"><span class="save-scope-pill instant">Instant Save</span></div>
            <h4>Live Immediately</h4>
            <p>Used for <b>Email / Webhook Notifications</b>, <b>Users (RBAC)</b>, <b>Scheduled SLA Digest</b>, and <b>Service Templates</b>. Active immediately without engine reload.</p>
          </div>
          <div class="step-card">
            <div style="margin-bottom:8px"><span class="save-scope-pill draft">Draft · Apply &amp; Reload</span></div>
            <h4>Staged Monitoring Objects</h4>
            <p>Used for <b>Hosts, Services, Commands, and Groups</b>. Saved as a draft first so you can batch edits, inspect <b>Review Changes</b>, validate, and apply cleanly.</p>
          </div>
          <div class="step-card">
            <div style="margin-bottom:8px"><span class="save-scope-pill auto">Auto-Reload Encore</span></div>
            <h4>Secrets &amp; Custom Scripts</h4>
            <p>Used for <b>Secrets (<code>$USERn$</code>)</b> and custom scripts in <code>$USER1$</code>. Written securely with mode <code>0600</code> and applied automatically.</p>
          </div>
        </div>
      </div>

      <div class="guide-card">
        <div class="guide-card-head"><h2>Status Legend, Flags &amp; Keyboard Shortcuts</h2></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <span class="badge c-ok">UP / OK (0)</span>
          <span class="badge c-warn">WARNING / UNREACH (1)</span>
          <span class="badge c-crit">CRITICAL / DOWN (2)</span>
          <span class="badge c-unk">UNKNOWN (3)</span>
          <span class="badge c-pend">PENDING</span>
        </div>
        <ul class="guide-steps">
          <li><span class="flag-tag">ACK</span> Problem acknowledged — suppresses repeated notifications until recovery.</li>
          <li><span class="flag-tag">DT</span> Active scheduled downtime window — alerts muted during maintenance.</li>
          <li><span class="flag-tag">SOFT</span> Retrying check before reaching <code>max_check_attempts</code> (no HARD alert yet).</li>
          <li><span class="flag-tag">FLAP</span> State is oscillating rapidly between OK and problem.</li>
          <li><b>Shortcuts:</b> <span class="code-chip">Ctrl+K</span> Quick Jump · <span class="code-chip">/</span> Global Search · <span class="code-chip">Shift+T</span> NOC TV Mode · <span class="code-chip">Esc</span> Close modal, drawer, or Customize Mode.</li>
        </ul>
      </div>`;
    return;
  }

  if (S.guideTab === 'menus') {
    const sections = guideMenuSections();
    el.innerHTML = `
      <div class="guide-card" style="padding:12px 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <span class="name-sub">Jump to section:</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${sections.map(s => `<button type="button" class="btn btn-sm" onclick="document.getElementById('gsec-${s.id}')?.scrollIntoView({behavior:'smooth',block:'start'})">${esc(s.title.split('—')[0].trim())}</button>`).join('')}
          </div>
        </div>
      </div>
      ${sections.map(s => `
        <div class="guide-card" id="gsec-${s.id}">
          <div class="guide-card-head"><h2>${esc(s.title)}</h2>${s.action}</div>
          <ul class="guide-steps">${s.items.map(i => `<li>${i}</li>`).join('')}</ul>
        </div>`).join('')}`;
    return;
  }

  if (S.guideTab === 'ncpa') {
    const snippet = ncpaInstallSnippet(S.ncpaOS);
    const verifyCmd = ncpaVerifySnippet();
    const metrics = ncpaMetricRows();
    el.innerHTML = `
      <div class="guide-card">
        <div class="guide-card-head">
          <h2>NCPA Agent Onboarding (3 Steps)</h2>
          <span class="badge c-ok">Port 5693 / HTTPS</span>
        </div>
        <div class="cards-3" style="margin-bottom:14px">
          <div class="step-card"><div class="step-num">1</div><h4>Install NCPA on Target</h4><p>Install the agent on Ubuntu, Debian, RHEL/Rocky, or Windows, set a strong token, and restrict port 5693 to the Encore server IP.</p></div>
          <div class="step-card"><div class="step-num">2</div><h4>Save Token as <code>$USER2$</code></h4><p>Store the NCPA token under <b>Manage → Secrets</b> so credentials stay encrypted out of host/service definitions.</p><div style="margin-top:8px">${guideAdminCTA('Open Secrets', "setView('manage','secrets')")}</div></div>
          <div class="step-card"><div class="step-num">3</div><h4>Register &amp; Apply Template</h4><p>Register <code>check_ncpa</code> once, then apply the <b>Linux/Windows NCPA</b> template to your hosts.</p><div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${guideAdminCTA('+ Register check_ncpa', 'quickRegisterNCPA()', 'btn btn-sm primary')}${guideAdminCTA('Templates', "setView('manage','templates')")}</div></div>
        </div>

        <div class="ncpa-gen-bar">
          <div class="form-row" style="margin:0;flex:1;min-width:170px">
            <label for="ncpa-tok-inp">Token (Interpolates Below)</label>
            <input id="ncpa-tok-inp" type="text" value="${esc(_guideNcpaToken)}" placeholder="YOUR_NCPA_TOKEN" oninput="updateNcpaVar('token',this.value)">
          </div>
          <div class="form-row" style="margin:0;flex:1;min-width:170px">
            <label for="ncpa-srv-inp">Encore Server IP / Host</label>
            <input id="ncpa-srv-inp" type="text" value="${esc(_guideNcpaServer)}" placeholder="10.0.0.5" oninput="updateNcpaVar('server',this.value)">
          </div>
          <div style="display:flex;gap:6px;align-self:flex-end;flex-wrap:wrap" role="group" aria-label="Target operating system">
            <button type="button" class="btn btn-sm ${S.ncpaOS==='ubuntu'?'active':''}" aria-pressed="${S.ncpaOS==='ubuntu'}" onclick="setNcpaOS('ubuntu')">Ubuntu / Debian</button>
            <button type="button" class="btn btn-sm ${S.ncpaOS==='rhel'?'active':''}" aria-pressed="${S.ncpaOS==='rhel'}" onclick="setNcpaOS('rhel')">RHEL / Rocky</button>
            <button type="button" class="btn btn-sm ${S.ncpaOS==='windows'?'active':''}" aria-pressed="${S.ncpaOS==='windows'}" onclick="setNcpaOS('windows')">Windows</button>
          </div>
        </div>

        <div class="code-block-wrap">
          <button type="button" class="btn btn-sm code-copy-btn" onclick="copyGuideBtn(this)">Copy</button>
          <pre class="guide-pre" id="ncpa-install-pre">${esc(snippet)}</pre>
        </div>

        <h3 style="font-size:13px;margin:14px 0 6px">Verify Connectivity from Encore Server</h3>
        <div class="code-block-wrap">
          <button type="button" class="btn btn-sm code-copy-btn" onclick="copyGuideBtn(this)">Copy</button>
          <pre class="guide-pre" id="ncpa-verify-pre">${esc(verifyCmd)}</pre>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">Ready-to-Use NCPA &amp; SSL Check Commands</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Check</th><th>Command Syntax</th><th style="text-align:right">Action</th></tr></thead>
          <tbody>
            ${metrics.map(m => `<tr>
              <td><b>${esc(m.name)}</b></td>
              <td><code class="code-chip">${esc(m.cmd)}</code></td>
              <td class="actions"><button type="button" class="btn btn-sm" data-copy="${esc(m.cmd)}" onclick="copyGuideBtn(this)">Copy</button></td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
    return;
  }

  if (S.guideTab === 'notify') {
    el.innerHTML = `
      <div class="guide-card">
        <div class="guide-card-head">
          <h2>Email SMTP &amp; Webhook Notifications</h2>
          ${guideAdminCTA('Open Notifications', "setView('manage','notifications')", 'btn btn-sm primary')}
        </div>
        <div class="cards-3" style="margin-bottom:14px">
          <div class="step-card"><div class="step-num">1</div><h4>Real-Time Dispatch</h4><p>Triggered automatically on state transitions (HARD-only recommended to avoid noise during transient retries).</p></div>
          <div class="step-card"><div class="step-num">2</div><h4>Multi-Channel Alerts</h4><p>Combine <b>Email SMTP</b> with emoji-formatted <b>Telegram, Discord, Slack,</b> or <b>Generic JSON Webhooks</b>.</p></div>
          <div class="step-card"><div class="step-num">3</div><h4>Instant Save &amp; Test</h4><p>Changes take effect immediately without reloading the engine; use <b>Send Test</b> to verify delivery.</p></div>
        </div>
        <h3 style="font-size:13px;margin-bottom:6px">Quick Email SMTP Setup (Gmail / Office365 / Corporate Relay)</h3>
        <ol class="guide-steps">
          <li>Open <b>Manage → Notifications</b> and check <b>Enable Email</b>.</li>
          <li>Enter SMTP Host, Port, and TLS Mode:
            <ul class="guide-steps" style="margin-top:4px">
              <li><b>Gmail:</b> <code>smtp.gmail.com</code> · Port <code>587</code> · <code>STARTTLS</code> (use a 16-char Google App Password).</li>
              <li><b>Microsoft 365:</b> <code>smtp.office365.com</code> · Port <code>587</code> · <code>STARTTLS</code>.</li>
              <li><b>Internal Relay:</b> Corporate relay IP · Port <code>25</code> or <code>587</code> · TLS <code>None</code> or <code>Skip TLS Verify</code>.</li>
            </ul>
          </li>
          <li>Set <b>From Address</b>, <b>Recipients</b> (comma-separated), and enable <b>Include Manage Contacts</b> if desired.</li>
          <li>Select trigger states (<code>DOWN</code>, <code>CRITICAL</code>, <code>RECOVERY</code>; keep <code>HARD State Only</code> checked).</li>
          <li>Click <b>Save Settings</b>, then click <b>Send Test Email</b> to confirm delivery.</li>
        </ol>
        <h3 style="font-size:13px;margin:14px 0 6px">Webhook Setup (Telegram / Discord / Slack / Custom)</h3>
        <ul class="guide-steps">
          <li><b>Telegram:</b> Create a bot via <code>@BotFather</code>, obtain the Bot Token and Chat ID, and enter <code>https://api.telegram.org/bot&lt;TOKEN&gt;/sendMessage?chat_id=&lt;CHAT_ID&gt;</code>.</li>
          <li><b>Discord / Slack:</b> Create an Incoming Webhook URL in your channel settings and paste it directly into <b>Webhook URL</b> (stored masked after save).</li>
          <li><b>Generic JSON:</b> Receives structured fields (<code>event</code>, <code>target</code>, <code>host</code>, <code>service</code>, <code>state</code>, <code>output</code>, <code>timestamp</code>).</li>
        </ul>
      </div>`;
    return;
  }

  if (S.guideTab === 'catalog') {
    el.innerHTML = `<div class="panel"><div class="skel-stack"><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div></div>`;
    try {
      const [cData, pData] = await Promise.all([
        S.catalogCmds.length ? Promise.resolve({ commands: S.catalogCmds }) : apiFetchJSON('/api/v1/catalog/commands'),
        _guidePluginsCache ? Promise.resolve(_guidePluginsCache) : apiFetchJSON('/api/v1/catalog/plugins')
      ]);
      S.catalogCmds = cData.commands || [];
      _guidePluginsCache = pData;
      const allPlugins = pData.plugins || [];
      const filteredPlugins = q ? allPlugins.filter(p => p.name.toLowerCase().includes(q)) : allPlugins;
      const shownPlugins = filteredPlugins.slice(0, 80);

      el.innerHTML = `
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Registered Check Commands (${S.catalogCmds.length})</div>
            <span class="name-sub">Use <b>Filter guide...</b> above to search commands &amp; plugins</span>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Command</th><th>Engine</th><th>Description</th><th>Example Usage</th><th style="text-align:right">Copy</th></tr></thead>
            <tbody id="cat-cmd-body">${renderCatalogRows(q)}</tbody>
          </table></div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Installed Plugins in $USER1$ (${filteredPlugins.length}${q ? ` of ${allPlugins.length}` : ''})</div>
            <span class="mono">${esc(pData.dir || '')}</span>
          </div>
          <div style="padding:14px 16px;display:flex;gap:6px;flex-wrap:wrap">
            ${shownPlugins.length ? shownPlugins.map(p => `<span class="code-chip" style="${p.custom?'border-color:var(--accent);color:var(--accent)':''}" title="${p.custom?'Custom script':''}">${esc(p.name)}</span>`).join('') : '<span class="name-sub">No matching plugins found.</span>'}
          </div>
          ${filteredPlugins.length > 80 ? `<div class="pager"><span>Showing first 80 of ${filteredPlugins.length} plugins — narrow with Filter guide...</span></div>` : ''}
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="error-card"><span>Failed to load catalog: ${esc(err.message)}</span><button type="button" class="btn btn-sm" onclick="S.catalogCmds=[];_guidePluginsCache=null;renderGuide()">Retry</button></div>`;
    }
    return;
  }

  // paths & FAQ
  el.innerHTML = `<div class="panel"><div class="skel-stack"><div class="skel" style="width:45%"></div><div class="skel"></div><div class="skel" style="width:65%"></div></div></div>`;
  try {
    if (!_guidePathsCache) {
      _guidePathsCache = await apiFetchJSON('/api/v1/catalog/paths');
    }
    const paths = _guidePathsCache;
    const rows = [
      ['Main Encore Config', paths.nagios_cfg],
      ['Encore Engine Binary', paths.nagios_bin],
      ['Query Handler Socket', paths.qh_socket],
      ['External Command Pipe', paths.cmd_pipe],
      ['Managed Config Directory', paths.managed_dir],
      ['Active Managed Config (.cfg)', paths.managed_cfg],
      ['Secrets File ($USERn$)', paths.resource_cfg],
      ['Plugins & Custom Scripts ($USER1$)', paths.plugins_dir]
    ];
    const faqs = guideFaqItems();
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Server File Locations</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Component</th><th>Path</th><th style="text-align:right">Copy</th></tr></thead>
          <tbody>${rows.map(([k, v]) => `<tr>
            <td><b>${esc(k)}</b></td>
            <td class="mono">${esc(v || '-')}</td>
            <td class="actions">${v ? `<button type="button" class="btn btn-sm" data-copy="${esc(v)}" onclick="copyGuideBtn(this)">Copy</button>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="guide-card">
        <div class="guide-card-head"><h2>Troubleshooting &amp; FAQ</h2></div>
        <ul class="guide-steps">
          ${faqs.map(f => `<li><b>${esc(f.q)}</b> ${f.a}</li>`).join('')}
        </ul>
      </div>`;
  } catch (err) {
    el.innerHTML = `<div class="error-card"><span>Failed to load server paths: ${esc(err.message)}</span><button type="button" class="btn btn-sm" onclick="_guidePathsCache=null;renderGuide()">Retry</button></div>`;
  }
}

function renderCatalogRows(q) {
  const ql = (q || '').trim().toLowerCase();
  const list = S.catalogCmds.filter(c => !ql || (c.name + ' ' + c.description + ' ' + c.example).toLowerCase().includes(ql));
  return list.length ? list.map(c => `<tr>
    <td><b>${esc(c.name)}</b></td>
    <td>${c.in_process ? '<span class="badge c-ok">Go Fast</span>' : '<span class="badge c-pend">Plugin</span>'}</td>
    <td class="name-sub">${esc(c.description)}</td>
    <td><code class="code-chip">${esc(c.example)}</code></td>
    <td class="actions"><button type="button" class="btn btn-sm" data-copy="${esc(c.example)}" onclick="copyGuideBtn(this)">Copy</button></td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty">No commands match filter</td></tr>';
}

function filterCatalogTable(q) {
  const b = document.getElementById('cat-cmd-body');
  if (b) b.innerHTML = renderCatalogRows(q);
}
