async function loadMeta() {
  const [hRes, sRes, hgRes, sgRes] = await Promise.all([
    fetch('/health'), fetch('/api/v1/summary'), fetch('/api/v1/hostgroups'), fetch('/api/v1/servicegroups')
  ]);
  const health = await hRes.json();
  const sum = await sRes.json();
  S.summary = sum;
  S.hostgroups = (await hgRes.json()).hostgroups || [];
  S.servicegroups = (await sgRes.json()).servicegroups || [];

  const dot = document.getElementById('conn-dot');
  if (dot) dot.className = health.connected ? 'pulse-dot ok' : 'pulse-dot crit';
  document.getElementById('conn-label').textContent = health.connected ? 'Live' : 'Reconnecting';
  document.getElementById('events-pill').textContent = (health.events_applied || 0).toLocaleString() + ' ev';
  document.getElementById('sub-meta').textContent = `PID ${sum.program.pid} • ${sum.hosts.total} hosts, ${sum.services.total} services • ${new Date().toLocaleTimeString()}`;

  const pbBanner = document.getElementById('pending-banner');
  const navPend = document.getElementById('nav-pending-badge');
  const revBtn = document.getElementById('mg-review-btn');
  if (health.pending_changes) {
    if (pbBanner) pbBanner.style.display = 'flex';
    if (navPend) navPend.style.display = 'inline-block';
    if (revBtn) revBtn.style.display = 'inline-flex';
    const diff = health.pending_diff || {};
    const parts = [];
    if (diff.added) parts.push(`+${diff.added} new`);
    if (diff.modified) parts.push(`${diff.modified} modified`);
    if (diff.deleted) parts.push(`${diff.deleted} deleted`);
    const sumEl = document.getElementById('pending-summary-text');
    if (sumEl) sumEl.innerHTML = `<b>Pending Nagios Config</b>${parts.length ? ' (' + parts.join(' • ') + ')' : ''} — belum aktif sampai Apply &amp; Reload.`;
    if (navPend) navPend.textContent = diff.total || '•';
  } else {
    if (pbBanner) pbBanner.style.display = 'none';
    if (navPend) navPend.style.display = 'none';
    if (revBtn) revBtn.style.display = 'none';
    S.managed.diff = { pending: false, total: 0, entries: [] };
  }

  const totalProb = sum.hosts.down + sum.hosts.unreachable + sum.services.warning + sum.services.critical + sum.services.unknown;
  const pb = document.getElementById('nav-prob-badge');
  pb.style.display = totalProb > 0 ? 'inline-block' : 'none';
  pb.textContent = totalProb;

  syncSelect('hg-select', 'All Hostgroups', S.hostgroups.map(g => g.group_name));
  syncSelect('sg-select', 'All Servicegroups', S.servicegroups.map(g => g.group_name));
}

function syncSelect(id, allLabel, names) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (names.includes(cur)) sel.value = cur;
}

function saveMonitorFilterState(v) {
  const f = v === 'problems' ? S.probFilter : S.invFilter;
  const st = document.getElementById('state-select');
  const un = document.getElementById('unhandled-chk');
  const so = document.getElementById('sort-select');
  if (st) f.state = st.value;
  if (un) f.unhandled = un.checked;
  if (so) f.sort = so.value;
}
function restoreMonitorFilterState(v) {
  const f = v === 'problems' ? S.probFilter : S.invFilter;
  const mode = v === 'problems' ? 'problems' : S.invTab;
  populateStateSelect(mode, f.state);
  const un = document.getElementById('unhandled-chk');
  const so = document.getElementById('sort-select');
  if (un) un.checked = !!f.unhandled;
  if (so) so.value = f.sort || 'severity';
}

/* ====== OVERVIEW: KPI + FLEET HEALTH MAP (GRID & TOPOLOGY) + MINI-CHARTS ====== */
function setOvMapMode(mode) {
  S.ovMapMode = mode;
  document.getElementById('ov-map-grid-btn')?.classList.toggle('active', mode === 'grid');
  document.getElementById('ov-map-topo-btn')?.classList.toggle('active', mode === 'topo');
  loadOverview();
}

function renderOverviewFleetMap(hosts) {
  const el = document.getElementById('ov-fleet-map');
  if (!el) return;
  if (!hosts.length) {
    el.innerHTML = `<div class="art-empty">${artSVG('servers')}<h4>No Hosts Monitored Yet</h4><p>Tambahkan host pertama Anda di menu Manage untuk mulai melihat peta kesehatan infrastruktur.</p></div>`;
    return;
  }

  if (S.ovMapMode === 'topo') {
    const list = hosts.slice(0, 14);
    const w = 560, h = Math.max(210, 44 + Math.ceil(list.length / 2) * 38);
    const cx = 86, cy = h / 2;
    const nodes = list.map((ho, i) => {
      const col = i % 2 === 0 ? 0 : 1;
      const row = Math.floor(i / 2);
      const nx = col === 0 ? 255 : 420;
      const ny = 30 + row * 38;
      const stroke = !ho.has_been_checked ? 'var(--muted)' : (ho.current_state === 1 || ho.svc_crit > 0 ? 'var(--crit)' : (ho.current_state === 2 || ho.svc_warn > 0 ? 'var(--warn)' : 'var(--ok)'));
      const lineCol = ho.current_state === 1 ? 'var(--crit)' : 'var(--border)';
      return `
        <path d="M ${cx+38} ${cy} C ${cx+95} ${cy}, ${nx-60} ${ny}, ${nx-62} ${ny}" fill="none" stroke="${lineCol}" stroke-width="1.6"/>
        <g style="cursor:pointer" onclick="focusHostFromMap('${esc(ho.name)}')">
          <title>${esc(ho.name)} (${esc(ho.address)}) — ${ho.svc_ok}/${ho.svc_total} OK, ${ho.svc_warn} WARN, ${ho.svc_crit} CRIT</title>
          <rect x="${nx-62}" y="${ny-14}" width="132" height="28" rx="7" fill="var(--surface)" stroke="${stroke}" stroke-width="1.8"/>
          <circle cx="${nx-50}" cy="${ny}" r="4" fill="${stroke}"/>
          <text x="${nx-40}" y="${ny+4}" fill="var(--text)" font-size="11" font-weight="600">${esc(ho.name.length > 13 ? ho.name.slice(0,12)+'…' : ho.name)}</text>
          <text x="${nx+62}" y="${ny+4}" text-anchor="end" fill="var(--muted)" font-size="10">${ho.svc_ok}/${ho.svc_total}</text>
        </g>`;
    }).join('');
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
      <rect x="${cx-44}" y="${cy-26}" width="84" height="52" rx="12" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2"/>
      <text x="${cx-2}" y="${cy-2}" text-anchor="middle" fill="var(--accent)" font-size="12" font-weight="700">ENCORE</text>
      <text x="${cx-2}" y="${cy+12}" text-anchor="middle" fill="var(--muted)" font-size="9.5">${hosts.length} hosts</text>
      ${nodes}
    </svg>${hosts.length > 14 ? `<div class="name-sub" style="text-align:right;margin-top:4px">Showing 14 of ${hosts.length} hosts — switch to Health Grid for full list</div>` : ''}`;
    return;
  }

  el.innerHTML = `<div class="fleet-grid">${hosts.slice(0, 24).map(ho => {
    const t = ho.svc_total || 1;
    const stCls = !ho.has_been_checked ? 'st-pend' : (ho.current_state === 1 || ho.svc_crit > 0 ? 'st-down' : (ho.current_state === 2 || ho.svc_warn > 0 ? 'st-warn' : ''));
    return `<div class="host-tile ${stCls}" onclick="focusHostFromMap('${esc(ho.name)}')" title="${esc(ho.name)} (${esc(ho.address)}) — Click to inspect services">
      <div class="host-tile-top">
        <span class="host-tile-name">${esc(ho.name)}</span>
        ${hostBadge(ho)}
      </div>
      <div class="mono" style="font-size:11px;margin-bottom:6px">${esc(ho.address)}</div>
      <div class="bar"><div class="bar-ok" style="width:${(ho.svc_ok/t)*100}%"></div><div class="bar-warn" style="width:${(ho.svc_warn/t)*100}%"></div><div class="bar-crit" style="width:${(ho.svc_crit/t)*100}%"></div></div>
      <div class="host-tile-meta">
        <span>${ho.svc_ok}/${ho.svc_total} OK</span>
        <span>${ho.svc_crit ? `<b style="color:var(--crit-fg)">${ho.svc_crit} CRIT</b>` : (ho.svc_warn ? `<b style="color:var(--warn-fg)">${ho.svc_warn} WARN</b>` : 'Healthy')}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function focusHostFromMap(hostName) {
  document.getElementById('global-search').value = hostName;
  S.invFilter.state = '';
  setView('inventory', 'services');
}

async function renderOverviewMiniCharts(sum) {
  const el = document.getElementById('ov-mini-charts');
  if (!el || !sum) return;
  const sc = sum.services;
  const tot = Math.max(1, sc.total);
  const okP = (sc.ok / tot) * 100, wP = (sc.warning / tot) * 100, cP = (sc.critical / tot) * 100, uP = ((sc.unknown + sc.pending) / tot) * 100;
  const r = 36, circ = 2 * Math.PI * r;
  const segs = [
    { p: okP, col: 'var(--ok)', lbl: 'OK', n: sc.ok },
    { p: wP, col: 'var(--warn)', lbl: 'WARN', n: sc.warning },
    { p: cP, col: 'var(--crit)', lbl: 'CRIT', n: sc.critical },
    { p: uP, col: 'var(--muted)', lbl: 'UNK/PEND', n: sc.unknown + sc.pending }
  ];
  let off = 0;
  const circles = segs.filter(s => s.p > 0).map(s => {
    const len = (s.p / 100) * circ;
    const out = `<circle cx="48" cy="48" r="${r}" fill="none" stroke="${s.col}" stroke-width="12" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 48 48)"/>`;
    off += len;
    return out;
  }).join('');

  // Fetch 24h trend at most once every 60 seconds
  const nowMs = Date.now();
  if (!S.ovTrendCache.data || nowMs - S.ovTrendCache.ts > 60000) {
    try {
      const nowS = Math.floor(nowMs / 1000);
      const res = await fetch(`/api/v1/reports/availability?from=${nowS-86400}&to=${nowS}&target=services`);
      if (res.ok) S.ovTrendCache = { ts: nowMs, data: await res.json() };
    } catch (e) {}
  }
  const tl = (S.ovTrendCache.data && S.ovTrendCache.data.timeline) || [];
  const sla24 = (S.ovTrendCache.data && S.ovTrendCache.data.summary && S.ovTrendCache.data.summary.overall_sla_pct) ?? 100;
  const inc24 = (S.ovTrendCache.data && S.ovTrendCache.data.summary && S.ovTrendCache.data.summary.total_incidents) ?? 0;

  let sparkHTML = '';
  if (tl.length) {
    const bw = Math.max(4, Math.floor(280 / tl.length) - 2);
    const bars = tl.map((b, i) => {
      const x = i * (280 / tl.length);
      const bh = Math.max(3, (b.ok_pct / 100) * 44);
      const col = b.ok_pct >= 99.5 ? 'var(--ok)' : (b.ok_pct >= 95 ? 'var(--warn)' : 'var(--crit)');
      return `<rect x="${x.toFixed(1)}" y="${(46 - bh).toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="2" fill="${col}"><title>${esc(b.label)} — ${b.ok_pct.toFixed(2)}% SLA (${b.incidents} inc)</title></rect>`;
    }).join('');
    sparkHTML = `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">
          <span style="font-weight:650">24h Uptime Trend</span>
          <span class="mono">SLA <b>${sla24.toFixed(2)}%</b> • ${inc24} HARD inc</span>
        </div>
        <svg viewBox="0 0 280 48" style="width:100%;height:48px;display:block">${bars}</svg>
      </div>`;
  }

  el.innerHTML = `
    <div class="donut-wrap">
      <svg width="96" height="96" viewBox="0 0 96 96" style="flex-shrink:0">
        <circle cx="48" cy="48" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="12"/>
        ${circles}
        <text x="48" y="47" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="700">${Math.round(okP)}%</text>
        <text x="48" y="60" text-anchor="middle" fill="var(--muted)" font-size="9">OK</text>
      </svg>
      <div class="donut-legend">
        ${segs.map(s => `<div class="legend-row"><span><span class="legend-dot" style="background:${s.col}"></span>${s.lbl}</span><b class="mono">${s.n}</b></div>`).join('')}
      </div>
    </div>
    ${sparkHTML}`;
}

async function loadOverview() {
  const sum = S.summary;
  if (!sum) return;
  const hPct = sum.hosts.total ? Math.round((sum.hosts.up / sum.hosts.total) * 100) : 100;
  const sPct = sum.services.total ? Math.round((sum.services.ok / sum.services.total) * 100) : 100;
  const unhand = sum.hosts.unhandled + sum.services.unhandled;

  document.getElementById('ov-h-pct').textContent = hPct + '%';
  document.getElementById('ov-h-up').textContent = sum.hosts.up + ' UP';
  document.getElementById('ov-h-down').textContent = sum.hosts.down + ' DOWN';
  document.getElementById('ov-h-tot').textContent = sum.hosts.total + ' total';
  document.getElementById('kpi-h-icon').src = sum.hosts.down > 0 ? '/assets/status/status-critical.svg' : '/assets/status/status-ok.svg';

  document.getElementById('ov-s-pct').textContent = sPct + '%';
  document.getElementById('ov-s-ok').textContent = sum.services.ok + ' OK';
  document.getElementById('ov-s-warn').textContent = sum.services.warning + ' WARN';
  document.getElementById('ov-s-crit').textContent = sum.services.critical + ' CRIT';
  document.getElementById('kpi-s-icon').src = sum.services.critical > 0 ? '/assets/status/status-critical.svg' : (sum.services.warning > 0 ? '/assets/status/status-warn.svg' : '/assets/status/status-ok.svg');

  document.getElementById('ov-unhandled').textContent = unhand;
  document.getElementById('ov-u-sub').textContent = unhand > 0 ? `${sum.hosts.unhandled} hosts, ${sum.services.unhandled} services` : 'All clear';
  document.getElementById('kpi-u-icon').src = unhand > 0 ? '/assets/status/status-critical.svg' : '/assets/status/status-ok.svg';

  document.getElementById('ov-pid').textContent = 'PID ' + sum.program.pid;
  document.getElementById('ov-flags').textContent = `Checks: ${sum.program.execute_service_checks ? 'ON' : 'OFF'} • Notify: ${sum.program.notifications_enabled ? 'ON' : 'OFF'}`;

  const [pRes, aRes, fhRes] = await Promise.all([
    fetch('/api/v1/services?unhandled=1&sort=severity&limit=10'),
    fetch('/api/v1/audit?limit=5'),
    fetch('/api/v1/hosts/health')
  ]);
  const probs = (await pRes.json()).services || [];
  const fleetHosts = (await fhRes.json()).hosts || [];

  renderOverviewFleetMap(fleetHosts);
  renderOverviewMiniCharts(sum);

  const pBody = document.getElementById('ov-prob-body');
  if (!probs.length) {
    pBody.innerHTML = `<tr><td colspan="5"><div class="art-empty">${artSVG('radar-ok')}<h4>All Systems Operational</h4><p>Tidak ada problem yang belum ditangani saat ini.</p></div></td></tr>`;
  } else {
    S.lastItems = probs;
    pBody.innerHTML = probs.map((s, idx) => `
      <tr class="clickable" onclick="openSvcDrawer(${idx})">
        <td>${svcBadge(s)}</td>
        <td><div class="name-primary">${esc(s.description)}</div><div class="name-sub">${esc(s.host_name)}</div></td>
        <td class="mono">${durStr(s.last_state_change)}</td>
        <td class="output-cell" title="${esc(s.plugin_output)}">${esc(s.plugin_output)}</td>
        <td class="actions" onclick="event.stopPropagation()">
          <button class="icon-btn" title="Force check" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${esc(s.host_name)};${esc(s.description)};'+Math.floor(Date.now()/1000),'Force check')">↻</button>
          <button class="icon-btn" title="Acknowledge" onclick="openAckModal('service','${esc(s.host_name)}','${esc(s.description)}')">✓</button>
        </td>
      </tr>`).join('');
  }

  document.getElementById('ov-hg-list').innerHTML = S.hostgroups.length ? S.hostgroups.slice(0, 6).map(g => {
    const t = g.services.total || 1;
    return `<div style="margin-bottom:12px;cursor:pointer" onclick="jumpToGroup('hg','${esc(g.group_name)}')">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
        <b>${esc(g.group_name)}</b><span class="mono">${g.hosts.up}/${g.hosts.total} UP • ${g.services.ok}/${g.services.total} OK</span>
      </div>
      <div class="bar"><div class="bar-ok" style="width:${(g.services.ok/t)*100}%"></div><div class="bar-warn" style="width:${(g.services.warning/t)*100}%"></div><div class="bar-crit" style="width:${(g.services.critical/t)*100}%"></div></div>
    </div>`;
  }).join('') : '<div class="empty" style="padding:14px">No hostgroups</div>';

  const audits = (await aRes.json()).entries || [];
  document.getElementById('ov-audit-list').innerHTML = audits.length ? audits.map(a => `
    <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
      <div><b>${esc(a.action)}</b> <span class="mono">${esc(a.target)}</span></div>
      <span class="mono">${relTime(Math.floor(Date.parse(a.time)/1000))}</span>
    </div>`).join('') : '<div class="empty" style="padding:14px">No activity yet</div>';
}

function renderMonitorSubtabs() {
  const el = document.getElementById('mon-subtabs');
  if (S.view === 'inventory') {
    el.innerHTML = `
      <button class="subtab ${S.invTab==='services'?'active':''}" onclick="setInvTab('services')">Services</button>
      <button class="subtab ${S.invTab==='hosts'?'active':''}" onclick="setInvTab('hosts')">Hosts</button>
      <button class="subtab ${S.invTab==='groups'?'active':''}" onclick="setInvTab('groups')">Groups</button>`;
  } else {
    el.innerHTML = `
      <button class="subtab ${S.probTab==='active'?'active':''}" onclick="setProbTab('active')">Active</button>
      <button class="subtab ${S.probTab==='downtimes'?'active':''}" onclick="setProbTab('downtimes')">Downtimes</button>`;
  }
}

function setInvTab(t) { S.invTab = t; S.invFilter.state = ''; S.offset = 0; S.selectedMon.clear(); populateStateSelect(t, ''); renderMonitorSubtabs(); loadMonitorView(); }
function setProbTab(t) { S.probTab = t; S.offset = 0; S.selectedMon.clear(); renderMonitorSubtabs(); loadMonitorView(); }
function quickUnhandled() { S.probFilter.unhandled = true; S.probFilter.state = ''; setView('problems', 'active'); }
function jumpToGroup(type, name) {
  document.getElementById('hg-select').value = type === 'hg' ? name : '';
  document.getElementById('sg-select').value = type === 'sg' ? name : '';
  S.invFilter.state = '';
  setView('inventory', 'services');
}
function onGlobalSearch() {
  if (S.view !== 'inventory' && S.view !== 'problems') setView('inventory', 'services');
  else { S.offset = 0; loadMonitorView(); }
}
function toggleGroupByHost() {
  S.groupByHost = !S.groupByHost;
  document.getElementById('group-view-btn').classList.toggle('active', S.groupByHost);
  loadMonitorView();
}
function onFilterChange() { saveMonitorFilterState(S.view); S.offset = 0; S.selectedMon.clear(); loadMonitorView(); }
function changePage(dir) {
  const limit = Number(document.getElementById('limit-select').value);
  const next = S.offset + dir * limit;
  if (next < 0 || next >= S.total) return;
  S.offset = next;
  S.selectedMon.clear();
  loadMonitorView();
}

function populateStateSelect(mode, desiredVal) {
  const sel = document.getElementById('state-select');
  if (!sel) return;
  const cur = desiredVal !== undefined ? desiredVal : sel.value;
  if (mode === 'hosts') {
    sel.innerHTML = '<option value="">All States</option><option value="0">UP</option><option value="1">DOWN</option><option value="2">UNREACH</option>';
  } else if (mode === 'problems') {
    sel.innerHTML = '<option value="">All Problems</option><option value="2">CRITICAL</option><option value="1">WARNING</option><option value="3">UNKNOWN</option>';
  } else {
    sel.innerHTML = '<option value="">All States</option><option value="0">OK</option><option value="1">WARN</option><option value="2">CRIT</option><option value="3">UNK</option>';
  }
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
}

/* Bulk Selection for Monitor (Modern Modals, zero native prompt()) */
function monItemKey(mode, item) { return mode === 'hosts' ? ('host::' + item.name) : ('svc::' + item.host_name + '::' + item.description); }
function toggleMonSelect(key, checked) { if (checked) S.selectedMon.add(key); else S.selectedMon.delete(key); renderBulkBar(); }
function toggleMonSelectAll(checked) {
  const mode = S.view === 'problems' ? 'problems' : S.invTab;
  S.selectedMon.clear();
  if (checked) S.lastItems.forEach(it => S.selectedMon.add(monItemKey(mode, it)));
  document.querySelectorAll('.mon-row-chk').forEach(cb => cb.checked = checked);
  renderBulkBar();
}
function renderBulkBar() {
  const bar = document.getElementById('mon-bulk-bar');
  if (!bar) return;
  if (S.selectedMon.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <div><b>${S.selectedMon.size}</b> selected</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-sm primary" onclick="bulkMonitorForceCheck()">↻ Force Check All</button>
      <button class="btn btn-sm" onclick="openBulkAckModal()">✓ Acknowledge All</button>
      <button class="btn btn-sm" onclick="openBulkDowntimeModal()">⏱ Schedule Downtime</button>
      <button class="btn btn-sm" onclick="S.selectedMon.clear();renderBulkBar();loadMonitorView()">Clear</button>
    </div>`;
}
function bulkMonitorForceCheck() {
  const now = Math.floor(Date.now()/1000);
  const cmds = [];
  S.selectedMon.forEach(k => {
    const p = k.split('::');
    if (p[0] === 'host') cmds.push(`SCHEDULE_FORCED_HOST_CHECK;${p[1]};${now}`);
    else cmds.push(`SCHEDULE_FORCED_SVC_CHECK;${p[1]};${p[2]};${now}`);
  });
  sendBatchCmds(cmds, 'Bulk force check');
}
function openBulkAckModal() {
  openModal(`<h2>Bulk Acknowledge (${S.selectedMon.size} items)</h2>
    <div class="form-row"><label>Comment</label><input id="ba-cmt" type="text" value="Bulk acknowledged via Encore"></div>
    <div style="display:flex;gap:10px;margin:8px 0">
      <label class="chk-pill"><input type="checkbox" id="ba-sticky" checked> Sticky</label>
      <label class="chk-pill"><input type="checkbox" id="ba-notify"> Notify</label>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitBulkAck()">Acknowledge All</button></div>`);
}
function submitBulkAck() {
  const cmt = document.getElementById('ba-cmt').value.trim() || 'Bulk acknowledged';
  const sticky = document.getElementById('ba-sticky').checked ? 2 : 1;
  const notify = document.getElementById('ba-notify').checked ? 1 : 0;
  const cmds = [];
  S.selectedMon.forEach(k => {
    const p = k.split('::');
    if (p[0] === 'host') cmds.push(`ACKNOWLEDGE_HOST_PROBLEM;${p[1]};${sticky};${notify};1;encore-ui;${cmt}`);
    else cmds.push(`ACKNOWLEDGE_SVC_PROBLEM;${p[1]};${p[2]};${sticky};${notify};1;encore-ui;${cmt}`);
  });
  closeModal();
  sendBatchCmds(cmds, 'Bulk acknowledge');
}
function openBulkDowntimeModal() {
  openModal(`<h2>Bulk Schedule Downtime (${S.selectedMon.size} items)</h2>
    <div class="form-row"><label>Duration (min)</label>
      <div class="presets">
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=30">30m</button>
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=60">1h</button>
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=240">4h</button>
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=1440">24h</button>
      </div>
      <input id="bdt-min" type="number" value="60" min="1">
    </div>
    <div class="form-row"><label>Comment</label><input id="bdt-cmt" type="text" value="Scheduled maintenance"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitBulkDowntime()">Schedule All</button></div>`);
}
function submitBulkDowntime() {
  const mins = Math.max(1, Number(document.getElementById('bdt-min').value) || 60);
  const cmt = document.getElementById('bdt-cmt').value.trim() || 'Maintenance';
  const now = Math.floor(Date.now()/1000);
  const cmds = [];
  S.selectedMon.forEach(k => {
    const p = k.split('::');
    if (p[0] === 'host') cmds.push(`SCHEDULE_HOST_DOWNTIME;${p[1]};${now};${now+mins*60};1;0;0;encore-ui;${cmt}`);
    else cmds.push(`SCHEDULE_SVC_DOWNTIME;${p[1]};${p[2]};${now};${now+mins*60};1;0;0;encore-ui;${cmt}`);
  });
  closeModal();
  sendBatchCmds(cmds, 'Bulk downtime');
}

async function loadMonitorView() {
  const isGroups = S.view === 'inventory' && S.invTab === 'groups';
  const isDT = S.view === 'problems' && S.probTab === 'downtimes';
  document.getElementById('mon-filters').style.display = (isGroups || isDT) ? 'none' : 'flex';
  if (isGroups || isDT) { S.selectedMon.clear(); renderBulkBar(); }

  if (isGroups) { renderGroupsView(); return; }
  if (isDT) { await renderDowntimesView(); return; }

  const mode = S.view === 'problems' ? 'problems' : S.invTab;
  document.getElementById('sg-select').style.display = mode === 'hosts' ? 'none' : '';
  document.getElementById('group-view-btn').style.display = mode === 'hosts' ? 'none' : '';
  const f = S.view === 'problems' ? S.probFilter : S.invFilter;
  populateStateSelect(mode, f.state);

  const q = document.getElementById('global-search').value.trim();
  const st = document.getElementById('state-select').value;
  const hg = document.getElementById('hg-select').value;
  const sg = document.getElementById('sg-select').value;
  const sort = document.getElementById('sort-select').value;
  const unhandled = document.getElementById('unhandled-chk').checked;
  const limit = Number(document.getElementById('limit-select').value);

  const params = new URLSearchParams({ limit, offset: S.offset, sort });
  if (q) params.set('search', q);
  if (st !== '') params.set('state', st);
  else if (mode === 'problems') params.set('problems', '1');
  if (hg) params.set('hostgroup', hg);
  if (sg && mode !== 'hosts') params.set('servicegroup', sg);
  if (unhandled) params.set('unhandled', '1');

  let rowsHTML = '', headHTML = '';
  if (mode === 'hosts') {
    headHTML = '<tr><th style="width:32px"><input type="checkbox" onclick="toggleMonSelectAll(this.checked)"></th><th>Status</th><th>Host</th><th>Duration</th><th>Last Check</th><th>Output</th><th style="text-align:right">Actions</th></tr>';
    const data = await (await fetch('/api/v1/hosts?' + params)).json();
    S.total = data.total; S.lastItems = data.hosts;
    rowsHTML = data.hosts.length ? data.hosts.map((h, idx) => {
      const k = monItemKey('hosts', h);
      return `<tr class="clickable" onclick="openHostDrawer(${idx})">
        <td onclick="event.stopPropagation()"><input type="checkbox" class="mon-row-chk" ${S.selectedMon.has(k)?'checked':''} onchange="toggleMonSelect('${esc(k)}',this.checked)"></td>
        <td>${hostBadge(h)}</td>
        <td><div class="name-primary">${esc(h.name)}${flagsHTML(h)}</div><div class="name-sub">${esc(h.address)}</div></td>
        <td class="mono">${durStr(h.last_state_change)}</td>
        <td class="mono">${relTime(h.last_check)}</td>
        <td class="output-cell" title="${esc(h.plugin_output)}">${esc(h.plugin_output || '-')}</td>
        <td class="actions" onclick="event.stopPropagation()">
          <button class="icon-btn" title="Force check" onclick="sendCmd('SCHEDULE_FORCED_HOST_CHECK;${esc(h.name)};'+Math.floor(Date.now()/1000),'Force check')">↻</button>
          <button class="icon-btn" title="Downtime" onclick="openDowntimeModal('host','${esc(h.name)}','')">⏱</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">No matching hosts</td></tr>';
  } else {
    headHTML = '<tr><th style="width:32px"><input type="checkbox" onclick="toggleMonSelectAll(this.checked)"></th><th>Status</th><th>Host / Service</th><th>Duration</th><th>Last Check</th><th>Output</th><th style="text-align:right">Actions</th></tr>';
    const data = await (await fetch('/api/v1/services?' + params)).json();
    S.total = data.total; S.lastItems = data.services;
    if (!data.services.length) {
      rowsHTML = `<tr><td colspan="7"><div class="art-empty">${artSVG(mode==='problems'?'radar-ok':'servers')}<h4>${mode==='problems'?'No Active Problems':'No Matching Services'}</h4><p>${mode==='problems'?'Semua service dalam kondisi sehat.':'Coba ubah filter atau kata kunci pencarian.'}</p></div></td></tr>`;
    } else {
      let lastHost = null;
      data.services.forEach((s, idx) => {
        const k = monItemKey('services', s);
        if (S.groupByHost && s.host_name !== lastHost) {
          lastHost = s.host_name;
          rowsHTML += `<tr class="group-row"><td colspan="7">${esc(s.host_name)}</td></tr>`;
        }
        rowsHTML += `<tr class="clickable" onclick="openSvcDrawer(${idx})">
          <td onclick="event.stopPropagation()"><input type="checkbox" class="mon-row-chk" ${S.selectedMon.has(k)?'checked':''} onchange="toggleMonSelect('${esc(k)}',this.checked)"></td>
          <td>${svcBadge(s)}</td>
          <td><div class="name-primary">${esc(s.description)}${flagsHTML(s)}</div>${S.groupByHost ? '' : `<div class="name-sub">${esc(s.host_name)}</div>`}</td>
          <td class="mono">${durStr(s.last_state_change)}</td>
          <td class="mono">${relTime(s.last_check)}</td>
          <td class="output-cell" title="${esc(s.plugin_output)}">${esc(s.plugin_output || '-')}</td>
          <td class="actions" onclick="event.stopPropagation()">
            <button class="icon-btn" title="Force check" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${esc(s.host_name)};${esc(s.description)};'+Math.floor(Date.now()/1000),'Force check')">↻</button>
            ${s.current_state > 0 && !s.acknowledged ? `<button class="icon-btn" title="Acknowledge" onclick="openAckModal('service','${esc(s.host_name)}','${esc(s.description)}')">✓</button>` : ''}
            <button class="icon-btn" title="Downtime" onclick="openDowntimeModal('service','${esc(s.host_name)}','${esc(s.description)}')">⏱</button>
          </td>
        </tr>`;
      });
    }
  }

  renderBulkBar();
  const start = S.total ? S.offset + 1 : 0;
  const end = Math.min(S.offset + limit, S.total);
  document.getElementById('mon-body').innerHTML = `
    <div class="panel">
      <div class="table-wrap"><table><thead>${headHTML}</thead><tbody>${rowsHTML}</tbody></table></div>
      <div class="pager">
        <span>Showing ${start}–${end} of ${S.total.toLocaleString()}</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" ${S.offset===0?'disabled':''} onclick="changePage(-1)">Prev</button>
          <button class="btn btn-sm" ${end>=S.total?'disabled':''} onclick="changePage(1)">Next</button>
        </div>
      </div>
    </div>`;
}

function renderGroupsView() {
  const hgCards = S.hostgroups.length ? S.hostgroups.map(g => {
    const t = g.services.total || 1;
    return `<div class="gcard" onclick="jumpToGroup('hg','${esc(g.group_name)}')">
      <h3>${esc(g.group_name)}</h3><p>${esc(g.alias || '')} • ${g.hosts.total} hosts, ${g.services.total} services</p>
      <div class="bar" style="margin-bottom:8px"><div class="bar-ok" style="width:${(g.services.ok/t)*100}%"></div><div class="bar-warn" style="width:${(g.services.warning/t)*100}%"></div><div class="bar-crit" style="width:${(g.services.critical/t)*100}%"></div></div>
      <div class="mono">UP:${g.hosts.up} DOWN:${g.hosts.down} | OK:${g.services.ok} WARN:${g.services.warning} CRIT:${g.services.critical}</div>
    </div>`;
  }).join('') : '<div class="empty">No hostgroups defined</div>';

  const sgCards = S.servicegroups.length ? S.servicegroups.map(g => {
    const t = g.services.total || 1;
    return `<div class="gcard" onclick="jumpToGroup('sg','${esc(g.group_name)}')">
      <h3>${esc(g.group_name)}</h3><p>${esc(g.alias || '')} • ${g.services.total} services</p>
      <div class="bar" style="margin-bottom:8px"><div class="bar-ok" style="width:${(g.services.ok/t)*100}%"></div><div class="bar-warn" style="width:${(g.services.warning/t)*100}%"></div><div class="bar-crit" style="width:${(g.services.critical/t)*100}%"></div></div>
      <div class="mono">OK:${g.services.ok} WARN:${g.services.warning} CRIT:${g.services.critical} UNK:${g.services.unknown}</div>
    </div>`;
  }).join('') : '<div class="empty">No servicegroups defined</div>';

  document.getElementById('mon-body').innerHTML = `
    <div class="panel"><div class="panel-head"><div class="panel-title"><img src="/assets/icons/network.svg">Hostgroups</div></div><div class="group-grid">${hgCards}</div></div>
    <div class="panel"><div class="panel-head"><div class="panel-title"><img src="/assets/icons/cpu.svg">Servicegroups</div></div><div class="group-grid">${sgCards}</div></div>`;
}

async function renderDowntimesView() {
  const [dtRes, recRes] = await Promise.all([fetch('/api/v1/downtimes'), fetch('/api/v1/downtimes/recurring')]);
  const dts = (await dtRes.json()).downtimes || [];
  const recs = (await recRes.json()).schedules || [];
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const rows = dts.length ? dts.map(d => {
    const delCmd = d.type === 1 ? `DEL_SVC_DOWNTIME;${d.downtime_id}` : `DEL_HOST_DOWNTIME;${d.downtime_id}`;
    return `<tr>
      <td class="mono">#${d.downtime_id}</td>
      <td><div class="name-primary">${esc(d.host_name)}</div>${d.service_description ? `<div class="name-sub">${esc(d.service_description)}</div>` : ''}</td>
      <td class="mono">${new Date(d.start_time*1000).toLocaleString()} → ${new Date(d.end_time*1000).toLocaleString()}</td>
      <td>${d.is_in_effect ? '<span class="badge c-warn">ACTIVE</span>' : '<span class="badge c-pend">SCHEDULED</span>'}</td>
      <td><b>${esc(d.author)}</b>: ${esc(d.comment)}</td>
      <td class="actions">${canOperate() ? `<button class="btn btn-sm danger" onclick="sendCmd('${jsEsc(delCmd)}','Cancel downtime #${d.downtime_id}')">Cancel</button>` : '-'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">No active or scheduled downtimes</td></tr>';

  const recRows = recs.length ? recs.map(r => `<tr>
    <td><b>${esc(r.name)}</b><div class="name-sub">${esc(r.comment)}</div></td>
    <td><span class="flag-tag">${esc(r.target_type)}</span> <span class="mono">${esc(r.target_type==='hostgroup'?r.hostgroup:(r.host + (r.service?' / '+r.service:'')))}</span></td>
    <td class="mono">${(r.days||[]).map(d => dayNames[d]).join(', ')} @ ${esc(r.start_time)} (${r.duration_min}m)</td>
    <td>${r.enabled ? '<span class="badge c-ok">ON</span>' : '<span class="badge c-pend">OFF</span>'}</td>
    <td class="actions">${canOperate() ? `<button class="btn btn-sm danger" onclick="deleteRecurringDT('${jsEsc(r.id)}','${jsEsc(r.name)}')">Delete</button>` : '-'}</td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty">No recurring maintenance schedules</td></tr>';

  document.getElementById('mon-body').innerHTML = `
    <div class="panel"><div class="panel-head"><div class="panel-title">Active &amp; Scheduled Downtimes (${dts.length})</div></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Target</th><th>Window</th><th>Status</th><th>Comment</th><th style="text-align:right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">Recurring Maintenance Schedules (${recs.length}) <span class="save-scope-pill instant">Auto Scheduler</span></div>
        ${canOperate() ? '<button class="btn btn-sm primary" onclick="openRecurringDTModal()">+ Add Schedule</button>' : ''}
      </div>
      <div class="table-wrap"><table><thead><tr><th>Schedule</th><th>Target</th><th>Recurrence</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>${recRows}</tbody></table></div>
    </div>`;
}

function openRecurringDTModal() {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  openModal(`<h2>Add Recurring Maintenance Schedule</h2>
    <div class="form-grid">
      <div class="form-row"><label>Schedule Name *</label><input id="rdt-name" type="text" placeholder="Weekly DB Backup"></div>
      <div class="form-row"><label>Target Type</label>
        <select id="rdt-type" onchange="document.getElementById('rdt-hg-row').style.display=this.value==='hostgroup'?'':'none';document.getElementById('rdt-h-row').style.display=this.value!=='hostgroup'?'':'none';document.getElementById('rdt-s-row').style.display=this.value==='service'?'':'none'">
          <option value="host">Host</option><option value="service">Service</option><option value="hostgroup">Hostgroup</option>
        </select>
      </div>
      <div class="form-row" id="rdt-h-row"><label>Host *</label><input id="rdt-host" type="text" placeholder="localhost"></div>
      <div class="form-row" id="rdt-s-row" style="display:none"><label>Service *</label><input id="rdt-svc" type="text" placeholder="HTTP"></div>
      <div class="form-row" id="rdt-hg-row" style="display:none"><label>Hostgroup *</label><input id="rdt-hg" type="text" placeholder="linux-servers"></div>
      <div class="form-row"><label>Start Time (24h HH:MM) *</label><input id="rdt-time" type="text" value="02:00"></div>
      <div class="form-row"><label>Duration (minutes) *</label><input id="rdt-dur" type="number" value="120" min="1"></div>
      <div class="form-row full"><label>Days of Week *</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${days.map((d,i)=>`<label class="chk-pill"><input type="checkbox" class="rdt-day" value="${i}" ${i===0?'checked':''}> ${d}</label>`).join('')}</div>
      </div>
      <div class="form-row full"><label>Comment</label><input id="rdt-cmt" type="text" value="Recurring scheduled maintenance"></div>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveRecurringDT()">Save Schedule</button></div>`);
}
async function saveRecurringDT() {
  const days = [...document.querySelectorAll('.rdt-day:checked')].map(c => Number(c.value));
  const payload = {
    name: document.getElementById('rdt-name').value.trim(),
    target_type: document.getElementById('rdt-type').value,
    host: document.getElementById('rdt-host').value.trim(),
    service: document.getElementById('rdt-svc').value.trim(),
    hostgroup: document.getElementById('rdt-hg').value.trim(),
    start_time: document.getElementById('rdt-time').value.trim(),
    duration_min: Number(document.getElementById('rdt-dur').value) || 60,
    days, comment: document.getElementById('rdt-cmt').value.trim(), enabled: true
  };
  const res = await fetch('/api/v1/downtimes/recurring', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  closeModal(); toast('Recurring schedule saved'); renderDowntimesView();
}
async function deleteRecurringDT(id, name) {
  const ok = await encoreConfirm({ title: `Delete Schedule "${name}"?`, message: 'Jadwal maintenance rutin ini tidak akan berjalan lagi.', confirmText: 'Delete', danger: true });
  if (!ok) return;
  const res = await fetch('/api/v1/downtimes/recurring?id=' + encodeURIComponent(id), { method:'DELETE' });
  if (res.ok) { toast('Deleted'); renderDowntimesView(); }
}

function parsePerfData(pd) {
  return pd ? pd.trim().split(/\s+/).filter(Boolean).map(tok => `<span class="perf-chip">${esc(tok)}</span>`).join('') : '';
}
function openHostDrawer(idx) {
  const h = S.lastItems[idx]; if (!h) return;
  document.getElementById('drawer-body').innerHTML = `
    <div class="drawer-head">
      <div>${hostBadge(h)} ${flagsHTML(h)}<h2 style="margin-top:6px">${esc(h.name)}</h2><div class="name-sub">${esc(h.address)}</div></div>
      <button class="btn btn-sm" onclick="closeDrawer()">✕</button>
    </div>
    <div class="kv-grid">
      <div class="kv-box"><div class="k">State Type</div><div class="v">${h.state_type===1?'HARD':'SOFT'} (${h.current_attempt}/${h.max_attempts})</div></div>
      <div class="kv-box"><div class="k">Duration</div><div class="v">${durStr(h.last_state_change)}</div></div>
      <div class="kv-box"><div class="k">Last Check</div><div class="v">${relTime(h.last_check)}</div></div>
      <div class="kv-box"><div class="k">Latency / Exec</div><div class="v">${h.latency.toFixed(3)}s / ${h.execution_time.toFixed(3)}s</div></div>
    </div>
    <div class="kv-box" style="margin-bottom:10px"><div class="k">Output</div><div class="mono" style="margin-top:4px;white-space:pre-wrap;color:var(--text)">${esc(h.plugin_output||'-')}</div></div>
    ${h.perf_data ? `<div class="kv-box" style="margin-bottom:12px"><div class="k">Performance Data</div><div class="perf-chips">${parsePerfData(h.perf_data)}</div></div>` : ''}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:14px">
      <button class="btn btn-sm primary" onclick="sendCmd('SCHEDULE_FORCED_HOST_CHECK;${esc(h.name)};'+Math.floor(Date.now()/1000),'Force check')">↻ Force Check</button>
      ${h.current_state>0 && !h.acknowledged ? `<button class="btn btn-sm" onclick="closeDrawer();openAckModal('host','${esc(h.name)}','')">✓ Acknowledge</button>` : ''}
      ${h.acknowledged ? `<button class="btn btn-sm" onclick="sendCmd('REMOVE_HOST_ACKNOWLEDGEMENT;${esc(h.name)}','Remove ACK')">Remove ACK</button>` : ''}
      <button class="btn btn-sm" onclick="closeDrawer();openDowntimeModal('host','${esc(h.name)}','')">⏱ Downtime</button>
      <button class="btn btn-sm" onclick="sendCmd('DISABLE_HOST_CHECK;${esc(h.name)}','Disable check')">Disable</button>
      <button class="btn btn-sm" onclick="sendCmd('ENABLE_HOST_CHECK;${esc(h.name)}','Enable check')">Enable</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <button class="btn btn-sm" onclick="closeDrawer();openReportFor('${esc(h.name)}','')">View SLA Report ›</button>
      <button class="btn btn-sm" onclick="closeDrawer();jumpToManageHost('${esc(h.name)}')">Edit Config ›</button>
      <button class="btn btn-sm" onclick="closeDrawer();jumpAddServiceForHost('${esc(h.name)}')">+ Add Service</button>
    </div>`;
  document.getElementById('drawer-wrap').classList.add('open');
}
function openSvcDrawer(idx) {
  const s = S.lastItems[idx]; if (!s) return;
  document.getElementById('drawer-body').innerHTML = `
    <div class="drawer-head">
      <div>${svcBadge(s)} ${flagsHTML(s)}<h2 style="margin-top:6px">${esc(s.description)}</h2><div class="name-sub">${esc(s.host_name)}</div></div>
      <button class="btn btn-sm" onclick="closeDrawer()">✕</button>
    </div>
    <div class="kv-grid">
      <div class="kv-box"><div class="k">State Type</div><div class="v">${s.state_type===1?'HARD':'SOFT'} (${s.current_attempt}/${s.max_attempts})</div></div>
      <div class="kv-box"><div class="k">Duration</div><div class="v">${durStr(s.last_state_change)}</div></div>
      <div class="kv-box"><div class="k">Last Check</div><div class="v">${relTime(s.last_check)}</div></div>
      <div class="kv-box"><div class="k">Latency / Exec</div><div class="v">${s.latency.toFixed(3)}s / ${s.execution_time.toFixed(3)}s</div></div>
    </div>
    <div class="kv-box" style="margin-bottom:10px"><div class="k">Output</div><div class="mono" style="margin-top:4px;white-space:pre-wrap;color:var(--text)">${esc(s.plugin_output||'-')}</div></div>
    ${s.perf_data ? `<div class="kv-box" style="margin-bottom:12px"><div class="k">Performance Data</div><div class="perf-chips">${parsePerfData(s.perf_data)}</div></div>` : ''}
    <div id="drawer-metrics-box" style="margin-bottom:12px"></div>
    ${canOperate() ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:14px">
      <button class="btn btn-sm primary" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)};'+Math.floor(Date.now()/1000),'Force check')">↻ Force Check</button>
      ${s.current_state>0 && !s.acknowledged ? `<button class="btn btn-sm" onclick="closeDrawer();openAckModal('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">✓ Acknowledge</button>` : ''}
      ${s.acknowledged ? `<button class="btn btn-sm" onclick="sendCmd('REMOVE_SVC_ACKNOWLEDGEMENT;${jsEsc(s.host_name)};${jsEsc(s.description)}','Remove ACK')">Remove ACK</button>` : ''}
      <button class="btn btn-sm" onclick="closeDrawer();openDowntimeModal('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">⏱ Downtime</button>
      ${isAdmin() ? `<button class="btn btn-sm" onclick="sendCmd('DISABLE_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)}','Disable check')">Disable</button>
      <button class="btn btn-sm" onclick="sendCmd('ENABLE_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)}','Enable check')">Enable</button>` : ''}
    </div>` : ''}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <button class="btn btn-sm" onclick="closeDrawer();openReportFor('${jsEsc(s.host_name)}','${jsEsc(s.description)}')">View SLA Report ›</button>
      <button class="btn btn-sm" onclick="closeDrawer();openMetricsFor('${jsEsc(s.host_name)}','${jsEsc(s.description)}')">Metrics Charts ›</button>
      ${isAdmin() ? `<button class="btn btn-sm" onclick="closeDrawer();jumpToManageHost('${jsEsc(s.host_name)}')">Edit Config ›</button>` : ''}
    </div>`;
  document.getElementById('drawer-wrap').classList.add('open');
  // Load mini metric trend chart inside drawer
  fetch(`/api/v1/metrics?host=${encodeURIComponent(s.host_name)}&service=${encodeURIComponent(s.description)}&range=6h`)
    .then(r => r.json()).then(d => {
      const box = document.getElementById('drawer-metrics-box');
      if (!box || !d.series || !d.series.length) return;
      const ser = d.series[0];
      box.innerHTML = `<div class="kv-box"><div class="k" style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Trend (6h): ${esc(ser.label)}</span><span>Last: ${ser.last}${esc(ser.unit||'')}</span></div>${renderMetricChartSVG(ser)}</div>`;
    }).catch(() => {});
}

function openAckModal(kind, host, desc) {
  openModal(`<h2>Acknowledge ${kind==='host'?host:host+' / '+desc}</h2>
    <div class="form-row"><label>Comment</label><input id="m-ack-cmt" type="text" value="Acknowledged via Encore"></div>
    <div style="display:flex;gap:12px;margin:8px 0">
      <label class="chk-pill"><input type="checkbox" id="m-ack-sticky" checked> Sticky</label>
      <label class="chk-pill"><input type="checkbox" id="m-ack-notify"> Notify</label>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitAck('${kind}','${esc(host)}','${esc(desc)}')">Acknowledge</button></div>`);
}
function submitAck(kind, host, desc) {
  const cmt = document.getElementById('m-ack-cmt').value.trim() || 'Acknowledged';
  const sticky = document.getElementById('m-ack-sticky').checked ? 2 : 1;
  const notify = document.getElementById('m-ack-notify').checked ? 1 : 0;
  const cmd = kind==='host' ? `ACKNOWLEDGE_HOST_PROBLEM;${host};${sticky};${notify};1;encore-ui;${cmt}` : `ACKNOWLEDGE_SVC_PROBLEM;${host};${desc};${sticky};${notify};1;encore-ui;${cmt}`;
  closeModal(); sendCmd(cmd, 'Acknowledge');
}
function openDowntimeModal(kind, host, desc) {
  openModal(`<h2>Schedule Downtime — ${kind==='host'?host:host+' / '+desc}</h2>
    <div class="form-row"><label>Duration (min)</label>
      <div class="presets">
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=30">30m</button>
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=60">1h</button>
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=240">4h</button>
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=1440">24h</button>
      </div>
      <input id="m-dt-min" type="number" value="60" min="1">
    </div>
    <div class="form-row"><label>Comment</label><input id="m-dt-cmt" type="text" value="Scheduled maintenance"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitDowntime('${kind}','${esc(host)}','${esc(desc)}')">Schedule</button></div>`);
}
function submitDowntime(kind, host, desc) {
  const mins = Math.max(1, Number(document.getElementById('m-dt-min').value) || 60);
  const cmt = document.getElementById('m-dt-cmt').value.trim() || 'Maintenance';
  const now = Math.floor(Date.now()/1000);
  const cmd = kind==='host' ? `SCHEDULE_HOST_DOWNTIME;${host};${now};${now+mins*60};1;0;0;encore-ui;${cmt}` : `SCHEDULE_SVC_DOWNTIME;${host};${desc};${now};${now+mins*60};1;0;0;encore-ui;${cmt}`;
  closeModal(); sendCmd(cmd, 'Schedule downtime');
}
