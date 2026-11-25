/* Safe object lookup registry for drawers (prevents SSE refresh index race conditions) */
const _drawerObjMap = new Map();
function regDrawerObj(key, obj) { _drawerObjMap.set(key, obj); return key; }

async function loadMeta() {
  const [health, sum, hgData, sgData] = await Promise.all([
    apiFetchJSON('/health'),
    apiFetchJSON('/api/v1/summary'),
    apiFetchJSON('/api/v1/hostgroups'),
    apiFetchJSON('/api/v1/servicegroups')
  ]);
  S.summary = sum;
  S.hostgroups = hgData.hostgroups || [];
  S.servicegroups = sgData.servicegroups || [];

  const dot = document.getElementById('conn-dot');
  if (dot) dot.className = health.connected ? 'pulse-dot ok' : 'pulse-dot crit';
  document.getElementById('conn-label').textContent = health.connected ? (S.sseConnected ? 'Live (SSE)' : 'Live') : 'Reconnecting';
  document.getElementById('events-pill').textContent = (health.events_applied || 0).toLocaleString() + ' ev';
  document.getElementById('sub-meta').textContent = `${sum.hosts.total} hosts · ${sum.services.total} services · PID ${sum.program.pid} · Updated ${new Date().toLocaleTimeString()}`;

  if (!health.connected) {
    setConnectionBanner(true, 'Encore Engine socket is reconnecting — live state updates are temporarily paused.');
  }

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
    if (sumEl) sumEl.innerHTML = `<b>Pending Encore Config</b>${parts.length ? ' (' + parts.join(' · ') + ')' : ''} — not active until Apply &amp; Reload.`;
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
  updateClearFiltersBtn();
}

function updateClearFiltersBtn() {
  const btn = document.getElementById('clear-filters-btn');
  if (!btn) return;
  const hasAny = !!(
    document.getElementById('global-search')?.value.trim() ||
    document.getElementById('hg-select')?.value ||
    document.getElementById('sg-select')?.value ||
    document.getElementById('state-select')?.value ||
    document.getElementById('unhandled-chk')?.checked
  );
  btn.style.display = hasAny ? 'inline-flex' : 'none';
}

function clearMonitorFilters() {
  const gs = document.getElementById('global-search');
  if (gs) gs.value = '';
  const hg = document.getElementById('hg-select');
  if (hg) hg.value = '';
  const sg = document.getElementById('sg-select');
  if (sg) sg.value = '';
  const st = document.getElementById('state-select');
  if (st) st.value = '';
  const un = document.getElementById('unhandled-chk');
  if (un) un.checked = false;
  S.invFilter.state = '';
  S.invFilter.unhandled = false;
  S.probFilter.state = '';
  S.probFilter.unhandled = false;
  S.offset = 0;
  updateClearFiltersBtn();
  loadMonitorView();
}

/* ====== OVERVIEW: INCIDENT-FIRST + FLEET HEALTH MAP + 24H UPTIME ====== */
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
    el.innerHTML = `<div class="art-empty">${artSVG('servers')}<h4>No Hosts Monitored Yet</h4><p>Add your first host under Manage to start tracking fleet health.</p></div>`;
    return;
  }

  if (S.ovMapMode === 'topo') {
    const list = hosts.slice(0, 16);
    const w = 560, h = 290, cx = 280, cy = 145;
    const rx = 205, ry = 104;
    const okHosts = hosts.filter(ho => ho.has_been_checked && ho.current_state === 0 && ho.svc_crit === 0).length;
    const healthPct = hosts.length ? Math.round((okHosts / hosts.length) * 100) : 100;

    const nodes = list.map((ho, i) => {
      const ang = -Math.PI / 2 + (i / Math.max(1, list.length)) * Math.PI * 2;
      const nx = cx + Math.cos(ang) * rx;
      const ny = cy + Math.sin(ang) * ry;
      const stTxt = !ho.has_been_checked ? 'PEND' : (ho.current_state === 1 ? 'DOWN' : (ho.svc_crit > 0 ? `${ho.svc_crit}C` : (ho.svc_warn > 0 ? `${ho.svc_warn}W` : 'OK')));
      const stroke = !ho.has_been_checked ? 'var(--muted)' : (ho.current_state === 1 || ho.svc_crit > 0 ? 'var(--crit)' : (ho.current_state === 2 || ho.svc_warn > 0 ? 'var(--warn)' : 'var(--ok)'));
      const lineCol = ho.current_state === 1 || ho.svc_crit > 0 ? 'var(--crit)' : 'var(--border-strong)';
      const shortName = ho.name.length > 10 ? ho.name.slice(0, 9) + '…' : ho.name;
      return `
        <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${lineCol}" stroke-width="${ho.current_state===1||ho.svc_crit>0?'1.6':'1'}" stroke-dasharray="${ho.current_state===1?'4 2':''}" opacity="0.75"/>
        <g style="cursor:pointer" role="button" tabindex="0" aria-label="${esc(ho.name)} (${stTxt})" onclick="focusHostFromMap('${jsEsc(ho.name)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();focusHostFromMap('${jsEsc(ho.name)}');}">
          <title>${esc(ho.name)} (${esc(ho.address)}) — ${ho.svc_ok}/${ho.svc_total} OK, ${ho.svc_warn} WARN, ${ho.svc_crit} CRIT</title>
          <rect x="${(nx-52).toFixed(1)}" y="${(ny-12).toFixed(1)}" width="104" height="24" rx="2" fill="var(--surface)" stroke="${stroke}" stroke-width="1.4"/>
          <rect x="${(nx-46).toFixed(1)}" y="${(ny-3).toFixed(1)}" width="6" height="6" rx="1" fill="${stroke}"/>
          <text x="${(nx-36).toFixed(1)}" y="${(ny+3.5).toFixed(1)}" fill="var(--text)" font-family="var(--font-mono)" font-size="9.5" font-weight="600">${esc(shortName)}</text>
          <text x="${(nx+47).toFixed(1)}" y="${(ny+3.5).toFixed(1)}" text-anchor="end" fill="${stroke}" font-family="var(--font-mono)" font-size="9" font-weight="700">${stTxt}</text>
        </g>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block" role="img" aria-label="Swiss radial fleet topology">
      <line x1="24" y1="${cy}" x2="${w-24}" y2="${cy}" stroke="var(--border)" stroke-width="0.8" stroke-dasharray="3 4"/>
      <line x1="${cx}" y1="12" x2="${cx}" y2="${h-12}" stroke="var(--border)" stroke-width="0.8" stroke-dasharray="3 4"/>
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
      <ellipse cx="${cx}" cy="${cy}" rx="${Math.round(rx*0.56)}" ry="${Math.round(ry*0.56)}" fill="none" stroke="var(--border)" stroke-width="0.8"/>
      ${nodes}
      <circle cx="${cx}" cy="${cy}" r="34" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>
      <text x="${cx}" y="${cy-4}" text-anchor="middle" fill="var(--text)" font-family="var(--font-mono)" font-size="11" font-weight="800" letter-spacing="0.06em">ENCORE</text>
      <text x="${cx}" y="${cy+10}" text-anchor="middle" fill="var(--muted)" font-family="var(--font-mono)" font-size="9.5">${healthPct}% · ${hosts.length}H</text>
    </svg>${hosts.length > 16 ? `<div class="name-sub" style="text-align:right;margin-top:6px">Showing 16 of ${hosts.length} hosts — switch to Health Grid or Inventory for full list</div>` : ''}`;
    return;
  }

  el.innerHTML = `<div class="fleet-grid">${hosts.slice(0, 24).map(ho => {
    const t = ho.svc_total || 1;
    const stCls = !ho.has_been_checked ? '' : (ho.current_state === 1 || ho.svc_crit > 0 ? 'st-down' : (ho.current_state === 2 || ho.svc_warn > 0 ? 'st-warn' : ''));
    return `<button type="button" class="host-tile ${stCls}" onclick="focusHostFromMap('${jsEsc(ho.name)}')" title="${esc(ho.name)} (${esc(ho.address)}) — Click to inspect services">
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
    </button>`;
  }).join('')}</div>${hosts.length > 24 ? `<div class="name-sub" style="text-align:right;margin-top:8px">Showing 24 of ${hosts.length} hosts — <a href="#inventory/byhost" style="color:var(--accent);font-weight:600" onclick="setView('inventory','byhost');return false">Open Inventory</a> for all hosts</div>` : ''}`;
}

function focusHostFromMap(hostName) {
  document.getElementById('global-search').value = hostName;
  S.invFilter.state = '';
  S.invCollapsedHosts.delete(hostName);
  S.invExpandedHosts.add(hostName);
  setView('inventory', 'byhost');
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

  const nowMs = Date.now();
  if (!S.ovTrendCache.data || nowMs - S.ovTrendCache.ts > 60000) {
    try {
      const nowS = Math.floor(nowMs / 1000);
      const d = await apiFetchJSON(`/api/v1/reports/availability?from=${nowS-86400}&to=${nowS}&target=services`);
      S.ovTrendCache = { ts: nowMs, data: d };
    } catch (e) {}
  }
  const tl = (S.ovTrendCache.data && S.ovTrendCache.data.timeline) || [];
  const ovSum = (S.ovTrendCache.data && S.ovTrendCache.data.summary) || {};
  const sla24 = ovSum.overall_sla_pct ?? 100;
  const inc24 = ovSum.total_incidents ?? 0;
  const prob24 = ovSum.total_problem_sec ?? 0;

  // Update 4th KPI Card (24h Service SLA)
  const slaVal = document.getElementById('ov-sla-val');
  const slaSub = document.getElementById('ov-sla-sub');
  const slaLed = document.getElementById('kpi-sla-led');
  if (slaVal) slaVal.textContent = sla24.toFixed(2) + '%';
  if (slaSub) slaSub.textContent = `${inc24} HARD inc` + (prob24 > 0 ? ` · ${fmtDurationSec(prob24)} down` : ' · No downtime');
  if (slaLed) slaLed.className = 'kpi-led ' + (sla24 >= 99.5 ? '' : (sla24 >= 95 ? 'warn' : 'crit'));

  let sparkHTML = '';
  if (tl.length) {
    sparkHTML = `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;margin-bottom:6px">
          <span style="font-weight:650" title="Percentage of time services remained OK over the last 24 hours">24h Service Uptime</span>
          <span class="mono"><b>${sla24.toFixed(2)}%</b> OK · ${inc24} HARD inc${prob24 > 0 ? ` · ${fmtDurationSec(prob24)} down` : ''}</span>
        </div>
        ${renderTrendSVG(tl, 88)}
      </div>`;
  }

  el.innerHTML = `
    <div class="donut-wrap">
      <svg width="96" height="96" viewBox="0 0 96 96" style="flex-shrink:0" role="img" aria-label="Service state distribution">
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
  const hLed = document.getElementById('kpi-h-led');
  if (hLed) hLed.className = 'kpi-led ' + (sum.hosts.down > 0 ? 'crit' : '');

  document.getElementById('ov-s-pct').textContent = sPct + '%';
  document.getElementById('ov-s-ok').textContent = sum.services.ok + ' OK';
  document.getElementById('ov-s-warn').textContent = sum.services.warning + ' WARN';
  document.getElementById('ov-s-crit').textContent = sum.services.critical + ' CRIT';
  const sLed = document.getElementById('kpi-s-led');
  if (sLed) sLed.className = 'kpi-led ' + (sum.services.critical > 0 ? 'crit' : (sum.services.warning > 0 ? 'warn' : ''));

  document.getElementById('ov-unhandled').textContent = unhand;
  document.getElementById('ov-u-sub').textContent = unhand > 0 ? `${sum.hosts.unhandled} hosts · ${sum.services.unhandled} services` : 'All clear';
  const uLed = document.getElementById('kpi-u-led');
  if (uLed) uLed.className = 'kpi-led ' + (unhand > 0 ? 'crit' : '');
  document.getElementById('kpi-unhandled-card')?.classList.toggle('is-alert', unhand > 0);

  // Incident-First Ordering: promote Unhandled Problems above Fleet Map whenever unhandled > 0
  const probPanel = document.getElementById('ov-prob-panel');
  const topSlot = document.getElementById('ov-incident-top');
  const homeSlot = document.getElementById('ov-incident-home');
  if (probPanel && topSlot && homeSlot) {
    probPanel.classList.toggle('panel-alert', unhand > 0);
    if (unhand > 0 && probPanel.parentElement !== topSlot) topSlot.appendChild(probPanel);
    else if (unhand === 0 && probPanel.parentElement !== homeSlot) homeSlot.appendChild(probPanel);
  }

  try {
    const [pData, aData, fhData] = await Promise.all([
      apiFetchJSON('/api/v1/services?unhandled=1&sort=severity&limit=10'),
      isAdmin() ? apiFetchJSON('/api/v1/audit?limit=5').catch(() => ({ entries: [] })) : Promise.resolve({ entries: [] }),
      apiFetchJSON('/api/v1/hosts/health')
    ]);
    const probs = pData.services || [];
    const fleetHosts = fhData.hosts || [];

    renderOverviewFleetMap(fleetHosts);
    renderOverviewMiniCharts(sum);

    const pBody = document.getElementById('ov-prob-body');
    if (!probs.length) {
      pBody.innerHTML = `<tr><td colspan="5"><div class="art-empty">${artSVG('radar-ok')}<h4>All Systems Operational</h4><p>No unhandled problems at this time.</p></div></td></tr>`;
    } else {
      pBody.innerHTML = probs.map(s => {
        const key = regDrawerObj('svc:' + s.host_name + ':' + s.description, s);
        return `
        <tr class="clickable" tabindex="0" onclick="openSvcDrawerByKey('${jsEsc(key)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSvcDrawerByKey('${jsEsc(key)}');}">
          <td>${svcBadge(s)}</td>
          <td><div class="name-primary">${esc(s.description)}${flagsHTML(s)}</div><div class="name-sub">${esc(s.host_name)}</div></td>
          <td class="mono">${durStr(s.last_state_change)}</td>
          <td class="output-cell" title="${esc(s.plugin_output)}">${esc(s.plugin_output)}</td>
          <td class="actions" onclick="event.stopPropagation()">
            ${canOperate() ? `
              <button class="icon-btn" title="Force check" aria-label="Force check ${esc(s.description)}" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)};'+Math.floor(Date.now()/1000),'Force check',this)">${uiIcon('refresh')}</button>
              <button class="icon-btn" title="Acknowledge" aria-label="Acknowledge ${esc(s.description)}" onclick="openAckModal('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">${uiIcon('check')}</button>
            ` : `<span class="name-sub">Read-only</span>`}
          </td>
        </tr>`;
      }).join('');
    }

    document.getElementById('ov-hg-list').innerHTML = S.hostgroups.length ? S.hostgroups.slice(0, 6).map(g => {
      const t = g.services.total || 1;
      return `<button type="button" class="gcard" style="margin-bottom:8px;padding:10px 12px" onclick="jumpToGroup('hg','${jsEsc(g.group_name)}')">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
          <b>${esc(g.group_name)}</b><span class="mono">${g.hosts.up}/${g.hosts.total} UP · ${g.services.ok}/${g.services.total} OK</span>
        </div>
        <div class="bar"><div class="bar-ok" style="width:${(g.services.ok/t)*100}%"></div><div class="bar-warn" style="width:${(g.services.warning/t)*100}%"></div><div class="bar-crit" style="width:${(g.services.critical/t)*100}%"></div></div>
      </button>`;
    }).join('') : '<div class="empty" style="padding:14px">No hostgroups defined</div>';

    if (isAdmin()) {
      const audits = aData.entries || [];
      document.getElementById('ov-audit-list').innerHTML = audits.length ? audits.map(a => `
        <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
          <div><b>${esc(a.action)}</b> <span class="mono">${esc(a.target)}</span></div>
          <span class="mono">${relTime(Math.floor(Date.parse(a.time)/1000))}</span>
        </div>`).join('') : '<div class="empty" style="padding:14px">No recent activity</div>';
    }
  } catch (err) {
    const fm = document.getElementById('ov-fleet-map');
    if (fm) fm.innerHTML = `<div class="error-card"><span>Failed to load overview data: ${esc(err.message)}</span><button class="btn btn-sm" onclick="loadOverview()">Retry</button></div>`;
  }
}

function renderMonitorSubtabs() {
  const el = document.getElementById('mon-subtabs');
  if (S.view === 'inventory') {
    el.innerHTML = `
      <button class="subtab ${S.invTab==='byhost'?'active':''}" onclick="setInvTab('byhost')">By Host</button>
      <button class="subtab ${S.invTab==='services'?'active':''}" onclick="setInvTab('services')">Services</button>
      <button class="subtab ${S.invTab==='hosts'?'active':''}" onclick="setInvTab('hosts')">Hosts</button>
      <button class="subtab ${S.invTab==='groups'?'active':''}" onclick="setInvTab('groups')">Groups</button>`;
  } else {
    el.innerHTML = `
      <button class="subtab ${S.probTab==='active'?'active':''}" onclick="setProbTab('active')">Active</button>
      <button class="subtab ${S.probTab==='downtimes'?'active':''}" onclick="setProbTab('downtimes')">Downtimes</button>`;
  }
}

function setInvTab(t) { S.invTab = t; S.invFilter.state = ''; S.offset = 0; S.selectedMon.clear(); populateStateSelect(t, ''); renderMonitorSubtabs(); syncHashFromState(); loadMonitorView(); }
function setProbTab(t) { S.probTab = t; S.offset = 0; S.selectedMon.clear(); renderMonitorSubtabs(); syncHashFromState(); loadMonitorView(); }
function quickUnhandled() { S.probFilter.unhandled = true; S.probFilter.state = ''; setView('problems', 'active'); }
function jumpToGroup(type, name) {
  document.getElementById('hg-select').value = type === 'hg' ? name : '';
  document.getElementById('sg-select').value = type === 'sg' ? name : '';
  S.invFilter.state = '';
  setView('inventory', 'byhost');
}
function onGlobalSearch() {
  updateClearFiltersBtn();
  if (S.view !== 'inventory' && S.view !== 'problems') setView('inventory', 'byhost');
  else { S.offset = 0; loadMonitorView(); }
}
function toggleGroupByHost() {
  S.groupByHost = !S.groupByHost;
  document.getElementById('group-view-btn').classList.toggle('active', S.groupByHost);
  loadMonitorView();
}
function onFilterChange() { saveMonitorFilterState(S.view); updateClearFiltersBtn(); S.offset = 0; S.selectedMon.clear(); loadMonitorView(); }
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
  if (mode === 'byhost') {
    sel.innerHTML = '<option value="">All Hosts</option><option value="problems">Has Problems</option><option value="healthy">Healthy Only</option><option value="2">CRIT / DOWN</option><option value="1">WARNING</option><option value="0">OK</option>';
  } else if (mode === 'hosts') {
    sel.innerHTML = '<option value="">All States</option><option value="0">UP</option><option value="1">DOWN</option><option value="2">UNREACH</option>';
  } else if (mode === 'problems') {
    sel.innerHTML = '<option value="">All Problems</option><option value="2">CRITICAL</option><option value="1">WARNING</option><option value="3">UNKNOWN</option>';
  } else {
    sel.innerHTML = '<option value="">All States</option><option value="0">OK</option><option value="1">WARN</option><option value="2">CRIT</option><option value="3">UNK</option>';
  }
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
}

/* Bulk Selection for Monitor */
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
  if (S.selectedMon.size === 0 || !canOperate()) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <div><b>${S.selectedMon.size}</b> selected</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-sm primary" onclick="bulkMonitorForceCheck()">${uiIcon('refresh')} Force Check All</button>
      <button class="btn btn-sm" onclick="openBulkAckModal()">${uiIcon('check')} Acknowledge All</button>
      <button class="btn btn-sm" onclick="openBulkDowntimeModal()">${uiIcon('clock')} Schedule Downtime</button>
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
    <div class="form-row"><label for="ba-cmt">Comment</label><input id="ba-cmt" type="text" value="Bulk acknowledged via Encore"></div>
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
    <div class="form-row"><label for="bdt-min">Duration (minutes)</label>
      <div class="presets">
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=30">30m</button>
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=60">1h</button>
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=240">4h</button>
        <button class="btn btn-sm" onclick="document.getElementById('bdt-min').value=1440">24h</button>
      </div>
      <input id="bdt-min" type="number" value="60" min="1">
    </div>
    <div class="form-row"><label for="bdt-cmt">Comment</label><input id="bdt-cmt" type="text" value="Scheduled maintenance"></div>
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

/* ====== INVENTORY BY HOST ACCORDION ====== */
function isInvHostOpen(hostName, q, groupCount) {
  if (S.invCollapsedHosts.has(hostName)) return false;
  if (S.invExpandedHosts.has(hostName)) return true;
  return !!q || groupCount <= 2;
}
function toggleInvHost(hostName) {
  const q = (document.getElementById('global-search')?.value || '').trim();
  const currentlyOpen = isInvHostOpen(hostName, q, (S.invLastGroups || []).length);
  if (currentlyOpen) {
    S.invExpandedHosts.delete(hostName);
    S.invCollapsedHosts.add(hostName);
  } else {
    S.invCollapsedHosts.delete(hostName);
    S.invExpandedHosts.add(hostName);
  }
  S.invExpandInit = true;
  renderInvByHostDOM();
}
function expandAllInvHosts(open) {
  S.invExpandInit = true;
  S.invExpandedHosts.clear();
  S.invCollapsedHosts.clear();
  if (open) S.invLastGroups.forEach(g => S.invExpandedHosts.add(g.host.name));
  else S.invLastGroups.forEach(g => S.invCollapsedHosts.add(g.host.name));
  renderInvByHostDOM();
}
function toggleInvHostSelectAll(gIdx, checked) {
  const g = S.invLastGroups[gIdx];
  if (!g) return;
  (g.services || []).forEach(s => {
    const k = monItemKey('services', s);
    if (checked) S.selectedMon.add(k);
    else S.selectedMon.delete(k);
  });
  renderBulkBar();
  renderInvByHostDOM();
}

function renderInvByHostDOM() {
  const groups = S.invLastGroups || [];
  const limit = Number(document.getElementById('limit-select')?.value || 50);
  const q = (document.getElementById('global-search')?.value || '').trim();
  const start = S.total ? S.offset + 1 : 0;
  const end = Math.min(S.offset + limit, S.total);

  renderBulkBar();
  if (!groups.length) {
    document.getElementById('mon-body').innerHTML = `
      <div class="panel"><div class="art-empty">${artSVG('servers')}<h4>No Matching Hosts</h4><p>Adjust your search query or clear active filters to see monitored hosts.</p></div></div>`;
    return;
  }

  const cards = groups.map((g, gIdx) => {
    const h = g.host;
    const svcs = g.services || [];
    const t = Math.max(1, g.svc_total || svcs.length);
    const open = isInvHostOpen(h.name, q, groups.length);
    const allSelected = svcs.length > 0 && svcs.every(s => S.selectedMon.has(monItemKey('services', s)));
    const hKey = regDrawerObj('host:' + h.name, h);
    const hgsHTML = (g.hostgroups || []).slice(0, 2).map(hg => `<span class="flag-tag">${esc(hg)}</span>`).join('');
    const probPill = g.svc_crit > 0
      ? `<span class="badge c-crit">${g.svc_crit} CRIT</span>`
      : (g.svc_warn > 0 ? `<span class="badge c-warn">${g.svc_warn} WARN</span>` : (g.svc_unk > 0 ? `<span class="badge c-unk">${g.svc_unk} UNK</span>` : `<span class="badge c-ok">${g.svc_ok}/${g.svc_total} OK</span>`));

    const svcRows = svcs.length ? svcs.map(s => {
      const k = monItemKey('services', s);
      const sKey = regDrawerObj('svc:' + s.host_name + ':' + s.description, s);
      return `<tr class="clickable" tabindex="0" onclick="openSvcDrawerByKey('${jsEsc(sKey)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSvcDrawerByKey('${jsEsc(sKey)}');}">
        ${canOperate() ? `<td style="width:32px" onclick="event.stopPropagation()"><input type="checkbox" class="mon-row-chk" aria-label="Select ${esc(s.description)}" ${S.selectedMon.has(k)?'checked':''} onchange="toggleMonSelect('${jsEsc(k)}',this.checked)"></td>` : ''}
        <td>${svcBadge(s)}</td>
        <td><div class="name-primary">${esc(s.description)}${flagsHTML(s)}</div></td>
        <td class="mono">${durStr(s.last_state_change)}</td>
        <td class="mono">${relTime(s.last_check)}</td>
        <td class="output-cell" title="${esc(s.plugin_output)}">${esc(s.plugin_output || '-')}</td>
        <td class="actions" onclick="event.stopPropagation()">
          ${canOperate() ? `
            <button class="icon-btn" title="Force check" aria-label="Force check ${esc(s.description)}" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)};'+Math.floor(Date.now()/1000),'Force check',this)">${uiIcon('refresh')}</button>
            ${s.current_state > 0 && !s.acknowledged ? `<button class="icon-btn" title="Acknowledge" aria-label="Acknowledge ${esc(s.description)}" onclick="openAckModal('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">${uiIcon('check')}</button>` : ''}
            <button class="icon-btn" title="Schedule downtime" aria-label="Schedule downtime for ${esc(s.description)}" onclick="openDowntimeModal('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">${uiIcon('clock')}</button>
          ` : `<button class="icon-btn" title="Inspect details" aria-label="Inspect ${esc(s.description)}" onclick="openSvcDrawerByKey('${jsEsc(sKey)}')">${uiIcon('info')}</button>`}
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="${canOperate()?7:6}" class="empty" style="padding:14px">No matching services on this host</td></tr>`;

    return `<div class="host-acc ${open?'open':''}">
      <div class="host-acc-head" role="button" tabindex="0" aria-expanded="${open?'true':'false'}" onclick="toggleInvHost('${jsEsc(h.name)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleInvHost('${jsEsc(h.name)}');}">
        <div class="host-acc-left">
          <span class="host-acc-chev">${uiIcon('chevron')}</span>
          ${canOperate() ? `<input type="checkbox" ${allSelected?'checked':''} aria-label="Select all services on ${esc(h.name)}" title="Select all services on ${esc(h.name)}" onclick="event.stopPropagation()" onchange="toggleInvHostSelectAll(${gIdx},this.checked)">` : ''}
          ${hostBadge(h)}
          <div>
            <span class="name-primary">${esc(h.name)}${flagsHTML(h)}</span>
            <span class="mono" style="margin-left:6px">${esc(h.address)}</span>
          </div>
          ${hgsHTML}
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap" onclick="event.stopPropagation()">
          <div style="width:92px" title="${g.svc_ok} OK, ${g.svc_warn} WARN, ${g.svc_crit} CRIT, ${g.svc_unk} UNK">
            <div class="bar">
              <div class="bar-ok" style="width:${(g.svc_ok/t)*100}%"></div>
              <div class="bar-warn" style="width:${(g.svc_warn/t)*100}%"></div>
              <div class="bar-crit" style="width:${(g.svc_crit/t)*100}%"></div>
              <div class="bar-unk" style="width:${(g.svc_unk/t)*100}%"></div>
            </div>
          </div>
          ${probPill}
          <div class="actions">
            ${canOperate() ? `
              <button class="icon-btn" title="Force check host" aria-label="Force check ${esc(h.name)}" onclick="sendCmd('SCHEDULE_FORCED_HOST_CHECK;${jsEsc(h.name)};'+Math.floor(Date.now()/1000),'Force check host',this)">${uiIcon('refresh')}</button>
              <button class="icon-btn" title="Host downtime" aria-label="Schedule downtime for ${esc(h.name)}" onclick="openDowntimeModal('host','${jsEsc(h.name)}','')">${uiIcon('clock')}</button>
            ` : ''}
            <button class="icon-btn" title="Host details" aria-label="Details for ${esc(h.name)}" onclick="openHostDrawerByKey('${jsEsc(hKey)}')">${uiIcon('info')}</button>
          </div>
        </div>
      </div>
      <div class="host-acc-body">
        <div class="table-wrap"><table><thead><tr>${canOperate()?'<th style="width:32px"></th>':''}<th>Status</th><th>Service</th><th>Duration</th><th>Last Check</th><th>Output</th><th style="text-align:right">Actions</th></tr></thead><tbody>${svcRows}</tbody></table></div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('mon-body').innerHTML = `
    <div class="panel">
      <div class="toolbar-row">
        <div class="name-sub">Showing <b>${start}–${end}</b> of <b>${S.total.toLocaleString()}</b> hosts · Select a host to inspect its services</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="expandAllInvHosts(true)">Expand All</button>
          <button class="btn btn-sm" onclick="expandAllInvHosts(false)">Collapse All</button>
        </div>
      </div>
      ${cards}
      <div class="pager">
        <span>Showing ${start}–${end} of ${S.total.toLocaleString()} hosts</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" ${S.offset===0?'disabled':''} onclick="changePage(-1)">Prev</button>
          <button class="btn btn-sm" ${end>=S.total?'disabled':''} onclick="changePage(1)">Next</button>
        </div>
      </div>
    </div>`;
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
  document.getElementById('group-view-btn').style.display = (mode === 'hosts' || mode === 'byhost') ? 'none' : '';
  const f = S.view === 'problems' ? S.probFilter : S.invFilter;
  populateStateSelect(mode, f.state);
  updateClearFiltersBtn();

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

  const bodyEl = document.getElementById('mon-body');
  if (bodyEl && !bodyEl.innerHTML.trim()) {
    bodyEl.innerHTML = `<div class="panel"><div class="skel-stack"><div class="skel" style="width:45%"></div><div class="skel"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div></div>`;
  }

  try {
    if (mode === 'byhost') {
      const data = await apiFetchJSON('/api/v1/inventory/by-host?' + params);
      S.total = data.total || 0;
      S.invLastGroups = data.hosts || [];
      if (!S.invExpandInit && S.invLastGroups.length) {
        let autoCnt = 0;
        for (const g of S.invLastGroups) {
          if (g.has_problem && autoCnt < 5) {
            S.invExpandedHosts.add(g.host.name);
            autoCnt++;
          }
        }
        S.invExpandInit = true;
      }
      renderInvByHostDOM();
      return;
    }

    let rowsHTML = '', headHTML = '';
    if (mode === 'hosts') {
      headHTML = `<tr>${canOperate()?'<th style="width:32px"><input type="checkbox" aria-label="Select all hosts" onclick="toggleMonSelectAll(this.checked)"></th>':''}<th>Status</th><th>Host</th><th>Duration</th><th>Last Check</th><th>Output</th><th style="text-align:right">Actions</th></tr>`;
      const data = await apiFetchJSON('/api/v1/hosts?' + params);
      S.total = data.total; S.lastItems = data.hosts;
      rowsHTML = data.hosts.length ? data.hosts.map(h => {
        const k = monItemKey('hosts', h);
        const hKey = regDrawerObj('host:' + h.name, h);
        return `<tr class="clickable" tabindex="0" onclick="openHostDrawerByKey('${jsEsc(hKey)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openHostDrawerByKey('${jsEsc(hKey)}');}">
          ${canOperate() ? `<td onclick="event.stopPropagation()"><input type="checkbox" class="mon-row-chk" aria-label="Select ${esc(h.name)}" ${S.selectedMon.has(k)?'checked':''} onchange="toggleMonSelect('${jsEsc(k)}',this.checked)"></td>` : ''}
          <td>${hostBadge(h)}</td>
          <td><div class="name-primary">${esc(h.name)}${flagsHTML(h)}</div><div class="name-sub">${esc(h.address)}</div></td>
          <td class="mono">${durStr(h.last_state_change)}</td>
          <td class="mono">${relTime(h.last_check)}</td>
          <td class="output-cell" title="${esc(h.plugin_output)}">${esc(h.plugin_output || '-')}</td>
          <td class="actions" onclick="event.stopPropagation()">
            ${canOperate() ? `
              <button class="icon-btn" title="Force check" aria-label="Force check ${esc(h.name)}" onclick="sendCmd('SCHEDULE_FORCED_HOST_CHECK;${jsEsc(h.name)};'+Math.floor(Date.now()/1000),'Force check',this)">${uiIcon('refresh')}</button>
              <button class="icon-btn" title="Downtime" aria-label="Schedule downtime for ${esc(h.name)}" onclick="openDowntimeModal('host','${jsEsc(h.name)}','')">${uiIcon('clock')}</button>
            ` : `<button class="icon-btn" title="Details" aria-label="Details for ${esc(h.name)}" onclick="openHostDrawerByKey('${jsEsc(hKey)}')">${uiIcon('info')}</button>`}
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="${canOperate()?7:6}" class="empty">No matching hosts</td></tr>`;
    } else {
      headHTML = `<tr>${canOperate()?'<th style="width:32px"><input type="checkbox" aria-label="Select all services" onclick="toggleMonSelectAll(this.checked)"></th>':''}<th>Status</th><th>Host / Service</th><th>Duration</th><th>Last Check</th><th>Output</th><th style="text-align:right">Actions</th></tr>`;
      const data = await apiFetchJSON('/api/v1/services?' + params);
      S.total = data.total; S.lastItems = data.services;
      if (!data.services.length) {
        rowsHTML = `<tr><td colspan="${canOperate()?7:6}"><div class="art-empty">${artSVG(mode==='problems'?'radar-ok':'servers')}<h4>${mode==='problems'?'No Active Problems':'No Matching Services'}</h4><p>${mode==='problems'?'All monitored services are healthy.':'Adjust your search or clear active filters.'}</p></div></td></tr>`;
      } else {
        let lastHost = null;
        data.services.forEach(s => {
          const k = monItemKey('services', s);
          const sKey = regDrawerObj('svc:' + s.host_name + ':' + s.description, s);
          if (S.groupByHost && s.host_name !== lastHost) {
            lastHost = s.host_name;
            rowsHTML += `<tr class="group-row"><td colspan="${canOperate()?7:6}">${esc(s.host_name)}</td></tr>`;
          }
          rowsHTML += `<tr class="clickable" tabindex="0" onclick="openSvcDrawerByKey('${jsEsc(sKey)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSvcDrawerByKey('${jsEsc(sKey)}');}">
            ${canOperate() ? `<td onclick="event.stopPropagation()"><input type="checkbox" class="mon-row-chk" aria-label="Select ${esc(s.description)}" ${S.selectedMon.has(k)?'checked':''} onchange="toggleMonSelect('${jsEsc(k)}',this.checked)"></td>` : ''}
            <td>${svcBadge(s)}</td>
            <td><div class="name-primary">${esc(s.description)}${flagsHTML(s)}</div>${S.groupByHost ? '' : `<div class="name-sub">${esc(s.host_name)}</div>`}</td>
            <td class="mono">${durStr(s.last_state_change)}</td>
            <td class="mono">${relTime(s.last_check)}</td>
            <td class="output-cell" title="${esc(s.plugin_output)}">${esc(s.plugin_output || '-')}</td>
            <td class="actions" onclick="event.stopPropagation()">
              ${canOperate() ? `
                <button class="icon-btn" title="Force check" aria-label="Force check ${esc(s.description)}" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)};'+Math.floor(Date.now()/1000),'Force check',this)">${uiIcon('refresh')}</button>
                ${s.current_state > 0 && !s.acknowledged ? `<button class="icon-btn" title="Acknowledge" aria-label="Acknowledge ${esc(s.description)}" onclick="openAckModal('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">${uiIcon('check')}</button>` : ''}
                <button class="icon-btn" title="Downtime" aria-label="Schedule downtime for ${esc(s.description)}" onclick="openDowntimeModal('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">${uiIcon('clock')}</button>
              ` : `<button class="icon-btn" title="Details" aria-label="Details for ${esc(s.description)}" onclick="openSvcDrawerByKey('${jsEsc(sKey)}')">${uiIcon('info')}</button>`}
            </td>
          </tr>`;
        });
      }
    }

    renderBulkBar();
    const start = S.total ? S.offset + 1 : 0;
    const end = Math.min(S.offset + limit, S.total);
    bodyEl.innerHTML = `
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
  } catch (err) {
    bodyEl.innerHTML = `<div class="error-card"><span>Failed to load inventory data: ${esc(err.message)}</span><button class="btn btn-sm" onclick="loadMonitorView()">Retry</button></div>`;
  }
}

function renderGroupsView() {
  const hgCards = S.hostgroups.length ? S.hostgroups.map(g => {
    const t = g.services.total || 1;
    return `<button type="button" class="gcard" onclick="jumpToGroup('hg','${jsEsc(g.group_name)}')">
      <h3>${esc(g.group_name)}</h3><p>${esc(g.alias || '')} · ${g.hosts.total} hosts, ${g.services.total} services</p>
      <div class="bar" style="margin-bottom:8px"><div class="bar-ok" style="width:${(g.services.ok/t)*100}%"></div><div class="bar-warn" style="width:${(g.services.warning/t)*100}%"></div><div class="bar-crit" style="width:${(g.services.critical/t)*100}%"></div></div>
      <div class="mono">UP:${g.hosts.up} DOWN:${g.hosts.down} | OK:${g.services.ok} WARN:${g.services.warning} CRIT:${g.services.critical}</div>
    </button>`;
  }).join('') : '<div class="empty">No hostgroups defined</div>';

  const sgCards = S.servicegroups.length ? S.servicegroups.map(g => {
    const t = g.services.total || 1;
    return `<button type="button" class="gcard" onclick="jumpToGroup('sg','${jsEsc(g.group_name)}')">
      <h3>${esc(g.group_name)}</h3><p>${esc(g.alias || '')} · ${g.services.total} services</p>
      <div class="bar" style="margin-bottom:8px"><div class="bar-ok" style="width:${(g.services.ok/t)*100}%"></div><div class="bar-warn" style="width:${(g.services.warning/t)*100}%"></div><div class="bar-crit" style="width:${(g.services.critical/t)*100}%"></div></div>
      <div class="mono">OK:${g.services.ok} WARN:${g.services.warning} CRIT:${g.services.critical} UNK:${g.services.unknown}</div>
    </button>`;
  }).join('') : '<div class="empty">No servicegroups defined</div>';

  document.getElementById('mon-body').innerHTML = `
    <div class="panel"><div class="panel-head"><div class="panel-title"><img src="/assets/icons/network.svg" alt="">Hostgroups</div></div><div class="group-grid">${hgCards}</div></div>
    <div class="panel"><div class="panel-head"><div class="panel-title"><img src="/assets/icons/cpu.svg" alt="">Servicegroups</div></div><div class="group-grid">${sgCards}</div></div>`;
}

async function renderDowntimesView() {
  const bodyEl = document.getElementById('mon-body');
  try {
    const [dtData, recData] = await Promise.all([
      apiFetchJSON('/api/v1/downtimes'),
      apiFetchJSON('/api/v1/downtimes/recurring')
    ]);
    const dts = dtData.downtimes || [];
    const recs = recData.schedules || [];
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    const rows = dts.length ? dts.map(d => {
      const delCmd = d.type === 1 ? `DEL_SVC_DOWNTIME;${d.downtime_id}` : `DEL_HOST_DOWNTIME;${d.downtime_id}`;
      return `<tr>
        <td class="mono">#${d.downtime_id}</td>
        <td><div class="name-primary">${esc(d.host_name)}</div>${d.service_description ? `<div class="name-sub">${esc(d.service_description)}</div>` : ''}</td>
        <td class="mono">${new Date(d.start_time*1000).toLocaleString()} → ${new Date(d.end_time*1000).toLocaleString()}</td>
        <td>${d.is_in_effect ? '<span class="badge c-warn">ACTIVE</span>' : '<span class="badge c-pend">SCHEDULED</span>'}</td>
        <td><b>${esc(d.author)}</b>: ${esc(d.comment)}</td>
        <td class="actions">${canOperate() ? `<button class="btn btn-sm danger" onclick="confirmCancelDowntime('${jsEsc(delCmd)}',${d.downtime_id})">Cancel</button>` : '-'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">No active or scheduled downtimes</td></tr>';

    const recRows = recs.length ? recs.map(r => `<tr>
      <td><b>${esc(r.name)}</b><div class="name-sub">${esc(r.comment)}</div></td>
      <td><span class="flag-tag">${esc(r.target_type)}</span> <span class="mono">${esc(r.target_type==='hostgroup'?r.hostgroup:(r.host + (r.service?' / '+r.service:'')))}</span></td>
      <td class="mono">${(r.days||[]).map(d => dayNames[d]).join(', ')} @ ${esc(r.start_time)} (${r.duration_min}m)</td>
      <td>${r.enabled ? '<span class="badge c-ok">ON</span>' : '<span class="badge c-pend">OFF</span>'}</td>
      <td class="actions">${canOperate() ? `<button class="btn btn-sm danger" onclick="deleteRecurringDT('${jsEsc(r.id)}','${jsEsc(r.name)}')">Delete</button>` : '-'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">No recurring maintenance schedules</td></tr>';

    bodyEl.innerHTML = `
      <div class="panel"><div class="panel-head"><div class="panel-title">Active &amp; Scheduled Downtimes (${dts.length})</div></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Target</th><th>Window</th><th>Status</th><th>Comment</th><th style="text-align:right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Recurring Maintenance Schedules (${recs.length}) <span class="save-scope-pill instant">Auto Scheduler</span></div>
          ${canOperate() ? '<button class="btn btn-sm primary" onclick="openRecurringDTModal()">+ Add Schedule</button>' : ''}
        </div>
        <div class="table-wrap"><table><thead><tr><th>Schedule</th><th>Target</th><th>Recurrence</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>${recRows}</tbody></table></div>
      </div>`;
  } catch (err) {
    bodyEl.innerHTML = `<div class="error-card"><span>Failed to load downtimes: ${esc(err.message)}</span><button class="btn btn-sm" onclick="renderDowntimesView()">Retry</button></div>`;
  }
}

async function confirmCancelDowntime(cmd, id) {
  const ok = await encoreConfirm({ title: `Cancel Downtime #${id}?`, message: 'Alerts for this target will resume immediately.', confirmText: 'Cancel Downtime', danger: true });
  if (ok) sendCmd(cmd, `Cancel downtime #${id}`);
}

function openRecurringDTModal() {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  openModal(`<h2>Add Recurring Maintenance Schedule</h2>
    <div class="form-grid">
      <div class="form-row"><label for="rdt-name">Schedule Name *</label><input id="rdt-name" type="text" placeholder="Weekly DB Backup"></div>
      <div class="form-row"><label for="rdt-type">Target Type</label>
        <select id="rdt-type" onchange="document.getElementById('rdt-hg-row').style.display=this.value==='hostgroup'?'':'none';document.getElementById('rdt-h-row').style.display=this.value!=='hostgroup'?'':'none';document.getElementById('rdt-s-row').style.display=this.value==='service'?'':'none'">
          <option value="host">Host</option><option value="service">Service</option><option value="hostgroup">Hostgroup</option>
        </select>
      </div>
      <div class="form-row" id="rdt-h-row"><label for="rdt-host">Host *</label><input id="rdt-host" type="text" placeholder="localhost"></div>
      <div class="form-row" id="rdt-s-row" style="display:none"><label for="rdt-svc">Service *</label><input id="rdt-svc" type="text" placeholder="HTTP"></div>
      <div class="form-row" id="rdt-hg-row" style="display:none"><label for="rdt-hg">Hostgroup *</label><input id="rdt-hg" type="text" placeholder="linux-servers"></div>
      <div class="form-row"><label for="rdt-time">Start Time (24h HH:MM) *</label><input id="rdt-time" type="text" value="02:00"></div>
      <div class="form-row"><label for="rdt-dur">Duration (minutes) *</label><input id="rdt-dur" type="number" value="120" min="1"></div>
      <div class="form-row full"><label>Days of Week *</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${days.map((d,i)=>`<label class="chk-pill"><input type="checkbox" class="rdt-day" value="${i}" ${i===0?'checked':''}> ${d}</label>`).join('')}</div>
      </div>
      <div class="form-row full"><label for="rdt-cmt">Comment</label><input id="rdt-cmt" type="text" value="Recurring scheduled maintenance"></div>
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
  try {
    await apiFetchJSON('/api/v1/downtimes/recurring', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    closeModal(); toast('Recurring schedule saved'); renderDowntimesView();
  } catch (e) { toast('Error: ' + e.message); }
}
async function deleteRecurringDT(id, name) {
  const ok = await encoreConfirm({ title: `Delete Schedule "${name}"?`, message: 'This recurring maintenance schedule will no longer trigger.', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await apiFetchJSON('/api/v1/downtimes/recurring?id=' + encodeURIComponent(id), { method:'DELETE' });
    toast('Deleted'); renderDowntimesView();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ====== DRAWERS (INLINE ACK/DOWNTIME + RBAC + CONFIRM ON DISABLE) ====== */
function parsePerfData(pd) {
  return pd ? pd.trim().split(/\s+/).filter(Boolean).map(tok => `<span class="perf-chip">${esc(tok)}</span>`).join('') : '';
}

function showDrawerInlineAck(kind, host, desc) {
  const slot = document.getElementById('drawer-inline-action');
  if (!slot) return;
  slot.innerHTML = `<div class="inline-action-box">
    <h3>Acknowledge ${esc(kind==='host'?host:desc)}</h3>
    <div class="form-row"><label for="dr-ack-cmt">Comment</label><input id="dr-ack-cmt" type="text" value="Acknowledged via Encore"></div>
    <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <label class="chk-pill" title="Keep acknowledgement until recovery"><input type="checkbox" id="dr-ack-sticky" checked> Sticky</label>
      <label class="chk-pill"><input type="checkbox" id="dr-ack-notify"> Send Notification</label>
    </div>
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button class="btn btn-sm" onclick="document.getElementById('drawer-inline-action').innerHTML=''">Cancel</button>
      <button class="btn btn-sm primary" onclick="submitDrawerInlineAck('${jsEsc(kind)}','${jsEsc(host)}','${jsEsc(desc)}',this)">Submit ACK</button>
    </div>
  </div>`;
  document.getElementById('dr-ack-cmt')?.focus();
}
function submitDrawerInlineAck(kind, host, desc, btn) {
  const cmt = document.getElementById('dr-ack-cmt').value.trim() || 'Acknowledged';
  const sticky = document.getElementById('dr-ack-sticky').checked ? 2 : 1;
  const notify = document.getElementById('dr-ack-notify').checked ? 1 : 0;
  const cmd = kind==='host' ? `ACKNOWLEDGE_HOST_PROBLEM;${host};${sticky};${notify};1;encore-ui;${cmt}` : `ACKNOWLEDGE_SVC_PROBLEM;${host};${desc};${sticky};${notify};1;encore-ui;${cmt}`;
  document.getElementById('drawer-inline-action').innerHTML = '';
  sendCmd(cmd, 'Acknowledge', btn);
}

function showDrawerInlineDowntime(kind, host, desc) {
  const slot = document.getElementById('drawer-inline-action');
  if (!slot) return;
  slot.innerHTML = `<div class="inline-action-box">
    <h3>Schedule Downtime — ${esc(kind==='host'?host:desc)}</h3>
    <div class="form-row"><label for="dr-dt-min">Duration (minutes)</label>
      <div class="presets">
        <button class="btn btn-sm" onclick="document.getElementById('dr-dt-min').value=30">30m</button>
        <button class="btn btn-sm" onclick="document.getElementById('dr-dt-min').value=60">1h</button>
        <button class="btn btn-sm" onclick="document.getElementById('dr-dt-min').value=240">4h</button>
        <button class="btn btn-sm" onclick="document.getElementById('dr-dt-min').value=1440">24h</button>
      </div>
      <input id="dr-dt-min" type="number" value="60" min="1">
    </div>
    <div class="form-row"><label for="dr-dt-cmt">Comment</label><input id="dr-dt-cmt" type="text" value="Scheduled maintenance"></div>
    <div style="display:flex;gap:6px;justify-content:flex-end">
      <button class="btn btn-sm" onclick="document.getElementById('drawer-inline-action').innerHTML=''">Cancel</button>
      <button class="btn btn-sm primary" onclick="submitDrawerInlineDT('${jsEsc(kind)}','${jsEsc(host)}','${jsEsc(desc)}',this)">Schedule</button>
    </div>
  </div>`;
  document.getElementById('dr-dt-min')?.focus();
}
function submitDrawerInlineDT(kind, host, desc, btn) {
  const mins = Math.max(1, Number(document.getElementById('dr-dt-min').value) || 60);
  const cmt = document.getElementById('dr-dt-cmt').value.trim() || 'Maintenance';
  const now = Math.floor(Date.now()/1000);
  const cmd = kind==='host' ? `SCHEDULE_HOST_DOWNTIME;${host};${now};${now+mins*60};1;0;0;encore-ui;${cmt}` : `SCHEDULE_SVC_DOWNTIME;${host};${desc};${now};${now+mins*60};1;0;0;encore-ui;${cmt}`;
  document.getElementById('drawer-inline-action').innerHTML = '';
  sendCmd(cmd, 'Schedule downtime', btn);
}

async function confirmDisableCheck(kind, host, desc) {
  const target = kind === 'host' ? host : `${host} / ${desc}`;
  const ok = await encoreConfirm({
    title: `Disable Active Checks for "${target}"?`,
    message: 'Encore Engine will stop monitoring this target until checks are re-enabled.',
    confirmText: 'Disable Checks',
    danger: true
  });
  if (!ok) return;
  const cmd = kind === 'host' ? `DISABLE_HOST_CHECK;${host}` : `DISABLE_SVC_CHECK;${host};${desc}`;
  sendCmd(cmd, 'Disable check');
}

function openHostDrawerByKey(key) { const h = _drawerObjMap.get(key); if (h) openHostDrawerObj(h); }
function openSvcDrawerByKey(key) { const s = _drawerObjMap.get(key); if (s) openSvcDrawerObj(s); }
function openHostDrawer(idx) { const h = S.lastItems[idx]; if (h) openHostDrawerObj(h); }
function openSvcDrawer(idx) { const s = S.lastItems[idx]; if (s) openSvcDrawerObj(s); }

function openHostDrawerObj(h) {
  document.getElementById('drawer-body').innerHTML = `
    <div class="drawer-head">
      <div>${hostBadge(h)} ${flagsHTML(h)}<h2 style="margin-top:6px">${esc(h.name)}</h2><div class="name-sub">${esc(h.address)}</div></div>
      <button class="icon-btn" onclick="closeDrawer()" title="Close drawer" aria-label="Close drawer">${uiIcon('x')}</button>
    </div>
    <div class="kv-grid">
      <div class="kv-box"><div class="k">State Type</div><div class="v">${h.state_type===1?'HARD':'SOFT'} (${h.current_attempt}/${h.max_attempts})</div></div>
      <div class="kv-box"><div class="k">Duration</div><div class="v">${durStr(h.last_state_change)}</div></div>
      <div class="kv-box"><div class="k">Last Check</div><div class="v">${relTime(h.last_check)}</div></div>
      <div class="kv-box"><div class="k">Latency / Exec</div><div class="v">${h.latency.toFixed(3)}s / ${h.execution_time.toFixed(3)}s</div></div>
    </div>
    <div class="kv-box" style="margin-bottom:10px"><div class="k">Output</div><div class="mono" style="margin-top:4px;white-space:pre-wrap;color:var(--text)">${esc(h.plugin_output||'-')}</div></div>
    ${h.perf_data ? `<div class="kv-box" style="margin-bottom:12px"><div class="k">Performance Data</div><div class="perf-chips">${parsePerfData(h.perf_data)}</div></div>` : ''}
    ${canOperate() ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0">
      <button class="btn btn-sm primary" onclick="sendCmd('SCHEDULE_FORCED_HOST_CHECK;${jsEsc(h.name)};'+Math.floor(Date.now()/1000),'Force check',this)">${uiIcon('refresh')} Force Check</button>
      ${h.current_state>0 && !h.acknowledged ? `<button class="btn btn-sm" onclick="showDrawerInlineAck('host','${jsEsc(h.name)}','')">${uiIcon('check')} Acknowledge</button>` : ''}
      ${h.acknowledged ? `<button class="btn btn-sm" onclick="sendCmd('REMOVE_HOST_ACKNOWLEDGEMENT;${jsEsc(h.name)}','Remove ACK',this)">Remove ACK</button>` : ''}
      <button class="btn btn-sm" onclick="showDrawerInlineDowntime('host','${jsEsc(h.name)}','')">${uiIcon('clock')} Downtime</button>
      ${isAdmin() ? `<button class="btn btn-sm danger" onclick="confirmDisableCheck('host','${jsEsc(h.name)}','')">Disable Checks</button>
      <button class="btn btn-sm" onclick="sendCmd('ENABLE_HOST_CHECK;${jsEsc(h.name)}','Enable check',this)">Enable Checks</button>` : ''}
    </div>` : ''}
    <div id="drawer-inline-action"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <button class="btn btn-sm" onclick="closeDrawer();openReportFor('${jsEsc(h.name)}','')">View SLA Report</button>
      ${isAdmin() ? `<button class="btn btn-sm" onclick="closeDrawer();jumpToManageHost('${jsEsc(h.name)}')">Edit Config</button>
      <button class="btn btn-sm" onclick="closeDrawer();jumpAddServiceForHost('${jsEsc(h.name)}')">+ Add Service</button>` : ''}
    </div>`;
  document.getElementById('drawer-wrap').classList.add('open');
}

function openSvcDrawerObj(s) {
  document.getElementById('drawer-body').innerHTML = `
    <div class="drawer-head">
      <div>${svcBadge(s)} ${flagsHTML(s)}<h2 style="margin-top:6px">${esc(s.description)}</h2><div class="name-sub">${esc(s.host_name)}</div></div>
      <button class="icon-btn" onclick="closeDrawer()" title="Close drawer" aria-label="Close drawer">${uiIcon('x')}</button>
    </div>
    <div class="kv-grid">
      <div class="kv-box"><div class="k">State Type</div><div class="v">${s.state_type===1?'HARD':'SOFT'} (${s.current_attempt}/${s.max_attempts})</div></div>
      <div class="kv-box"><div class="k">Duration</div><div class="v">${durStr(s.last_state_change)}</div></div>
      <div class="kv-box"><div class="k">Last Check</div><div class="v">${relTime(s.last_check)}</div></div>
      <div class="kv-box"><div class="k">Latency / Exec</div><div class="v">${s.latency.toFixed(3)}s / ${s.execution_time.toFixed(3)}s</div></div>
    </div>
    <div class="kv-box" style="margin-bottom:10px"><div class="k">Output</div><div class="mono" style="margin-top:4px;white-space:pre-wrap;color:var(--text)">${esc(s.plugin_output||'-')}</div></div>
    ${s.perf_data ? `<div class="kv-box" style="margin-bottom:12px"><div class="k">Performance Data</div><div class="perf-chips">${parsePerfData(s.perf_data)}</div></div>` : ''}
    ${canOperate() ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0">
      <button class="btn btn-sm primary" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)};'+Math.floor(Date.now()/1000),'Force check',this)">${uiIcon('refresh')} Force Check</button>
      ${s.current_state>0 && !s.acknowledged ? `<button class="btn btn-sm" onclick="showDrawerInlineAck('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">${uiIcon('check')} Acknowledge</button>` : ''}
      ${s.acknowledged ? `<button class="btn btn-sm" onclick="sendCmd('REMOVE_SVC_ACKNOWLEDGEMENT;${jsEsc(s.host_name)};${jsEsc(s.description)}','Remove ACK',this)">Remove ACK</button>` : ''}
      <button class="btn btn-sm" onclick="showDrawerInlineDowntime('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">${uiIcon('clock')} Downtime</button>
      ${isAdmin() ? `<button class="btn btn-sm danger" onclick="confirmDisableCheck('service','${jsEsc(s.host_name)}','${jsEsc(s.description)}')">Disable Checks</button>
      <button class="btn btn-sm" onclick="sendCmd('ENABLE_SVC_CHECK;${jsEsc(s.host_name)};${jsEsc(s.description)}','Enable check',this)">Enable Checks</button>` : ''}
    </div>` : ''}
    <div id="drawer-inline-action"></div>
    <div id="drawer-metrics-box" style="margin:12px 0;min-height:190px"><div class="kv-box"><div class="k" style="margin-bottom:8px">6h Metric Trend</div><div class="skel" style="height:150px"></div></div></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <button class="btn btn-sm" onclick="closeDrawer();openReportFor('${jsEsc(s.host_name)}','${jsEsc(s.description)}')">View SLA Report</button>
      <button class="btn btn-sm" onclick="closeDrawer();openMetricsFor('${jsEsc(s.host_name)}','${jsEsc(s.description)}')">Metrics Charts</button>
      ${isAdmin() ? `<button class="btn btn-sm" onclick="closeDrawer();jumpToManageHost('${jsEsc(s.host_name)}')">Edit Config</button>` : ''}
    </div>`;
  document.getElementById('drawer-wrap').classList.add('open');

  apiFetchJSON(`/api/v1/metrics?host=${encodeURIComponent(s.host_name)}&service=${encodeURIComponent(s.description)}&range=6h`)
    .then(d => {
      const box = document.getElementById('drawer-metrics-box');
      if (!box) return;
      if (!d.series || !d.series.length) {
        box.style.minHeight = '0';
        box.innerHTML = '';
        return;
      }
      const ser = d.series[0];
      box.innerHTML = `<div class="kv-box"><div class="k" style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Trend (6h): ${esc(ser.label)} — hover for values</span><span>Last: <b>${ser.last}${esc(ser.unit||'')}</b></span></div>${renderMetricChartSVG(ser, { width: 460, height: 175 })}</div>`;
    }).catch(() => {
      const box = document.getElementById('drawer-metrics-box');
      if (box) { box.style.minHeight = '0'; box.innerHTML = ''; }
    });
}

function openAckModal(kind, host, desc) {
  openModal(`<h2>Acknowledge ${esc(kind==='host'?host:host+' / '+desc)}</h2>
    <div class="form-row"><label for="m-ack-cmt">Comment</label><input id="m-ack-cmt" type="text" value="Acknowledged via Encore"></div>
    <div style="display:flex;gap:12px;margin:8px 0">
      <label class="chk-pill"><input type="checkbox" id="m-ack-sticky" checked> Sticky</label>
      <label class="chk-pill"><input type="checkbox" id="m-ack-notify"> Notify</label>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitAck('${jsEsc(kind)}','${jsEsc(host)}','${jsEsc(desc)}')">Acknowledge</button></div>`);
}
function submitAck(kind, host, desc) {
  const cmt = document.getElementById('m-ack-cmt').value.trim() || 'Acknowledged';
  const sticky = document.getElementById('m-ack-sticky').checked ? 2 : 1;
  const notify = document.getElementById('m-ack-notify').checked ? 1 : 0;
  const cmd = kind==='host' ? `ACKNOWLEDGE_HOST_PROBLEM;${host};${sticky};${notify};1;encore-ui;${cmt}` : `ACKNOWLEDGE_SVC_PROBLEM;${host};${desc};${sticky};${notify};1;encore-ui;${cmt}`;
  closeModal(); sendCmd(cmd, 'Acknowledge');
}
function openDowntimeModal(kind, host, desc) {
  openModal(`<h2>Schedule Downtime — ${esc(kind==='host'?host:host+' / '+desc)}</h2>
    <div class="form-row"><label for="m-dt-min">Duration (minutes)</label>
      <div class="presets">
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=30">30m</button>
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=60">1h</button>
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=240">4h</button>
        <button class="btn btn-sm" onclick="document.getElementById('m-dt-min').value=1440">24h</button>
      </div>
      <input id="m-dt-min" type="number" value="60" min="1">
    </div>
    <div class="form-row"><label for="m-dt-cmt">Comment</label><input id="m-dt-cmt" type="text" value="Scheduled maintenance"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitDowntime('${jsEsc(kind)}','${jsEsc(host)}','${jsEsc(desc)}')">Schedule</button></div>`);
}
function submitDowntime(kind, host, desc) {
  const mins = Math.max(1, Number(document.getElementById('m-dt-min').value) || 60);
  const cmt = document.getElementById('m-dt-cmt').value.trim() || 'Maintenance';
  const now = Math.floor(Date.now()/1000);
  const cmd = kind==='host' ? `SCHEDULE_HOST_DOWNTIME;${host};${now};${now+mins*60};1;0;0;encore-ui;${cmt}` : `SCHEDULE_SVC_DOWNTIME;${host};${desc};${now};${now+mins*60};1;0;0;encore-ui;${cmt}`;
  closeModal(); sendCmd(cmd, 'Schedule downtime');
}
