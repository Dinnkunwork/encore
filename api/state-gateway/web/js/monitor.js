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
  const hasAnyCrit = sum.hosts.down > 0 || sum.services.critical > 0;
  const pb = document.getElementById('nav-prob-badge');
  pb.style.display = totalProb > 0 ? 'inline-block' : 'none';
  pb.classList.toggle('warn', totalProb > 0 && !hasAnyCrit);
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

/* ====== OVERVIEW: CUSTOMIZABLE 12-COL GRID + FLEET MAP + 24H UPTIME + LIVE METRICS ====== */
const OV_LAYOUT_KEY = 'encore-ov-layout-v1';
const OV_WIDGET_DEFAULTS = [
  { id: 'fleet-map', label: 'Fleet Health Map', span: 7 },
  { id: 'uptime', label: 'Distribution & 24h Uptime', span: 5 },
  { id: 'metrics', label: 'Live Metrics (6h)', span: 12 },
  { id: 'problems', label: 'Unhandled Problems', span: 7 },
  { id: 'hostgroups', label: 'Hostgroups', span: 5 },
  { id: 'activity', label: 'Recent Activity', span: 5 }
];
const OV_VALID_SPANS = [5, 6, 7, 12];
let _ovLayoutState = null;
let _ovDragId = null;

function defaultOvLayout() {
  return {
    order: OV_WIDGET_DEFAULTS.map(w => w.id),
    spans: Object.fromEntries(OV_WIDGET_DEFAULTS.map(w => [w.id, w.span])),
    hidden: [],
    autoPinProblems: true
  };
}

function loadOvLayout() {
  if (_ovLayoutState) return _ovLayoutState;
  const def = defaultOvLayout();
  try {
    const raw = localStorage.getItem(OV_LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const validIds = new Set(def.order);
      const order = Array.isArray(parsed.order) ? parsed.order.filter(id => validIds.has(id)) : [];
      def.order.forEach(id => { if (!order.includes(id)) order.push(id); });
      const spans = { ...def.spans };
      if (parsed.spans && typeof parsed.spans === 'object') {
        Object.keys(spans).forEach(id => {
          const v = Number(parsed.spans[id]);
          if (OV_VALID_SPANS.includes(v)) spans[id] = v;
        });
      }
      const hidden = Array.isArray(parsed.hidden) ? parsed.hidden.filter(id => validIds.has(id)) : [];
      const autoPinProblems = parsed.autoPinProblems !== false;
      _ovLayoutState = { order, spans, hidden, autoPinProblems };
      return _ovLayoutState;
    }
  } catch (e) {}
  _ovLayoutState = def;
  return _ovLayoutState;
}

function saveOvLayout() {
  if (!_ovLayoutState) return;
  try { localStorage.setItem(OV_LAYOUT_KEY, JSON.stringify(_ovLayoutState)); } catch (e) {}
}

function announceOvLayout(msg) {
  const el = document.getElementById('ov-sr-announce');
  if (el) el.textContent = msg;
}

function applyOvLayout(unhandCount) {
  const grid = document.getElementById('ov-widget-grid');
  if (!grid) return;
  const st = loadOvLayout();
  const autoChk = document.getElementById('ov-auto-pin-chk');
  if (autoChk) autoChk.checked = !!st.autoPinProblems;

  const unhand = typeof unhandCount === 'number'
    ? unhandCount
    : ((S.summary?.hosts?.unhandled || 0) + (S.summary?.services?.unhandled || 0));

  st.order.forEach(id => {
    const card = grid.querySelector(`.ov-widget[data-widget-id="${id}"]`);
    if (!card) return;
    grid.appendChild(card);
    OV_VALID_SPANS.forEach(sp => card.classList.remove('span-' + sp));
    card.classList.add('span-' + (st.spans[id] || 6));
    const isHidden = st.hidden.includes(id) || (id === 'activity' && !isAdmin());
    card.classList.toggle('ov-hidden', isHidden);
    card.classList.toggle('ov-auto-pinned', id === 'problems' && st.autoPinProblems && unhand > 0 && !S.ovEditLayout && !isHidden);
    card.draggable = !!S.ovEditLayout;
    if (!card._ovDndBound) {
      card._ovDndBound = true;
      card.addEventListener('dragstart', e => {
        if (!S.ovEditLayout) { e.preventDefault(); return; }
        _ovDragId = id;
        S.ovDragging = true;
        card.classList.add('is-dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }
      });
      card.addEventListener('dragend', () => {
        _ovDragId = null;
        S.ovDragging = false;
        grid.querySelectorAll('.ov-widget').forEach(el => el.classList.remove('is-dragging', 'is-drop-target'));
      });
      card.addEventListener('dragover', e => {
        if (!S.ovEditLayout || !_ovDragId || _ovDragId === id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        card.classList.add('is-drop-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'));
      card.addEventListener('drop', e => {
        if (!S.ovEditLayout || !_ovDragId || _ovDragId === id) return;
        e.preventDefault();
        card.classList.remove('is-drop-target');
        const fromIdx = st.order.indexOf(_ovDragId);
        const toIdx = st.order.indexOf(id);
        if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
          st.order.splice(fromIdx, 1);
          st.order.splice(toIdx, 0, _ovDragId);
          saveOvLayout();
          applyOvLayout();
          announceOvLayout(`Moved ${_ovDragId} widget`);
        }
      });
    }
  });

  const tray = document.getElementById('ov-hidden-tray');
  if (tray) {
    const visibleHidden = st.hidden.filter(id => id !== 'activity' || isAdmin());
    tray.innerHTML = visibleHidden.length
      ? visibleHidden.map(id => {
          const meta = OV_WIDGET_DEFAULTS.find(w => w.id === id);
          return `<button type="button" class="btn btn-sm" onclick="toggleOvWidgetHidden('${id}')" title="Restore hidden widget">+ ${esc(meta ? meta.label : id)}</button>`;
        }).join('')
      : '';
  }
}

function toggleOverviewLayoutEdit(force) {
  S.ovEditLayout = typeof force === 'boolean' ? force : !S.ovEditLayout;
  document.body.classList.toggle('ov-editing', S.ovEditLayout);
  const btn = document.getElementById('ov-customize-btn');
  if (btn) btn.textContent = S.ovEditLayout ? 'Done' : 'Customize';
  applyOvLayout();
  if (S.ovEditLayout) toast('Customize Mode active — drag widgets or use ↑/↓');
}

function moveOvWidget(id, delta) {
  const st = loadOvLayout();
  const visibleOrder = st.order.filter(wid => !st.hidden.includes(wid) && (wid !== 'activity' || isAdmin()));
  const vIdx = visibleOrder.indexOf(id);
  const nextVIdx = vIdx + delta;
  if (vIdx < 0 || nextVIdx < 0 || nextVIdx >= visibleOrder.length) return;
  const swapId = visibleOrder[nextVIdx];
  const a = st.order.indexOf(id), b = st.order.indexOf(swapId);
  [st.order[a], st.order[b]] = [st.order[b], st.order[a]];
  saveOvLayout();
  applyOvLayout();
  announceOvLayout(`Moved ${id} ${delta < 0 ? 'up' : 'down'}`);
}

function cycleOvWidgetSpan(id) {
  const st = loadOvLayout();
  const cur = st.spans[id] || 6;
  const nextMap = { 5: 6, 6: 7, 7: 12, 12: 6 };
  st.spans[id] = nextMap[cur] || 6;
  saveOvLayout();
  applyOvLayout();
  const lbl = st.spans[id] === 12 ? 'Full width' : (st.spans[id] === 6 ? 'Half width' : `${st.spans[id]}/12 width`);
  toast(`Widget width: ${lbl}`);
}

function toggleOvWidgetHidden(id) {
  const st = loadOvLayout();
  const idx = st.hidden.indexOf(id);
  if (idx >= 0) st.hidden.splice(idx, 1);
  else st.hidden.push(id);
  saveOvLayout();
  applyOvLayout();
}

function toggleOvAutoPin(checked) {
  const st = loadOvLayout();
  st.autoPinProblems = !!checked;
  saveOvLayout();
  applyOvLayout();
}

function resetOvLayout() {
  _ovLayoutState = defaultOvLayout();
  saveOvLayout();
  applyOvLayout();
  toast('Overview layout reset to default');
}

function setOvMapMode(mode) {
  S.ovMapMode = mode === 'topo' ? 'topo' : 'grid';
  try { localStorage.setItem('encore-ov-map-mode', S.ovMapMode); } catch (e) {}
  document.getElementById('ov-map-grid-btn')?.classList.toggle('active', S.ovMapMode === 'grid');
  document.getElementById('ov-map-topo-btn')?.classList.toggle('active', S.ovMapMode === 'topo');
  loadOverview();
}

function renderOverviewFleetMap(hosts) {
  const el = document.getElementById('ov-fleet-map');
  if (!el) return;
  document.getElementById('ov-map-grid-btn')?.classList.toggle('active', S.ovMapMode === 'grid');
  document.getElementById('ov-map-topo-btn')?.classList.toggle('active', S.ovMapMode === 'topo');
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
      const lineCol = ho.current_state === 1 || ho.svc_crit > 0 ? 'var(--crit)' : (ho.current_state === 2 || ho.svc_warn > 0 ? 'var(--warn)' : 'var(--border-strong)');
      const shortName = ho.name.length > 10 ? ho.name.slice(0, 9) + '…' : ho.name;
      return `
        <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${lineCol}" stroke-width="${ho.current_state===1||ho.svc_crit>0?'1.6':'1'}" stroke-dasharray="${ho.current_state===1?'4 2':''}" opacity="0.75"/>
        <g style="cursor:pointer" role="button" tabindex="0" aria-label="${esc(ho.name)} (${stTxt})" onclick="focusHostFromMap('${jsEsc(ho.name)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();focusHostFromMap('${jsEsc(ho.name)}');}">
          <title>${esc(ho.name)} (${esc(ho.address)}) — ${ho.svc_ok}/${ho.svc_total} OK, ${ho.svc_warn} WARN, ${ho.svc_crit} CRIT</title>
          <rect x="${(nx-52).toFixed(1)}" y="${(ny-12).toFixed(1)}" width="104" height="24" rx="6" fill="var(--surface)" stroke="${stroke}" stroke-width="1.4"/>
          <rect x="${(nx-46).toFixed(1)}" y="${(ny-3).toFixed(1)}" width="6" height="6" rx="3" fill="${stroke}"/>
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
        <span class="host-name-wrap" style="gap:6px">${hostIconBadge(ho, 'sm')}<span class="host-tile-name">${esc(ho.name)}</span></span>
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
  let availErr = '';
  if (!S.ovTrendCache.data || nowMs - S.ovTrendCache.ts > 60000) {
    try {
      const nowS = Math.floor(nowMs / 1000);
      const d = await apiFetchJSON(`/api/v1/reports/availability?from=${nowS-86400}&to=${nowS}&target=services`);
      S.ovTrendCache = { ts: nowMs, data: d };
    } catch (e) {
      availErr = e.message || 'Availability unavailable';
    }
  }
  const tl = (S.ovTrendCache.data && S.ovTrendCache.data.timeline) || [];
  const ovSum = (S.ovTrendCache.data && S.ovTrendCache.data.summary) || {};
  const sla24 = ovSum.overall_sla_pct ?? 100;
  const critPct24 = ovSum.crit_pct || 0;
  const critInc24 = ovSum.crit_incidents ?? (critPct24 > 0 ? (ovSum.total_incidents || 0) : 0);
  const warnInc24 = ovSum.warn_incidents ?? (critPct24 === 0 ? (ovSum.total_incidents || 0) : 0);
  const prob24 = ovSum.total_problem_sec ?? 0;

  // Update 4th KPI Card (24h Service SLA) — RED only when actual critical/down exists
  const slaVal = document.getElementById('ov-sla-val');
  const slaSub = document.getElementById('ov-sla-sub');
  const slaLed = document.getElementById('kpi-sla-led');
  if (availErr && !S.ovTrendCache.data) {
    if (slaVal) slaVal.textContent = 'N/A';
    if (slaSub) slaSub.textContent = 'Availability unavailable';
    if (slaLed) slaLed.className = 'kpi-led warn';
  } else {
    if (slaVal) slaVal.textContent = sla24.toFixed(2) + '%';
    const durLbl = critPct24 > 0 ? 'down' : 'warn';
    const incSummary = critInc24 > 0
      ? `${critInc24} crit${warnInc24 > 0 ? ` · ${warnInc24} warn` : ''}`
      : (warnInc24 > 0 ? `${warnInc24} warn` : '0 HARD inc');
    if (slaSub) slaSub.textContent = incSummary + (prob24 > 0 ? ` · ${fmtDurationSec(prob24)} ${durLbl}` : ' · No issues');
    const slaLedCls = sla24 >= 99.5 && critInc24 === 0 ? '' : ((critPct24 > 0 || critInc24 > 0) && sla24 < 95 ? 'crit' : 'warn');
    if (slaLed) slaLed.className = 'kpi-led ' + slaLedCls;
  }

  let sparkHTML = '';
  if (tl.length) {
    sparkHTML = `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;margin-bottom:6px">
          <span style="font-weight:650" title="Hourly service state proportion over the last 24 hours">24h Service Uptime</span>
          <span class="trend-legend">
            <span class="trend-legend-it"><span class="tl-sw" style="background:var(--ok)"></span>OK</span>
            <span class="trend-legend-it"><span class="tl-sw" style="background:var(--warn)"></span>Warn</span>
            <span class="trend-legend-it"><span class="tl-sw" style="background:var(--crit)"></span>Crit</span>
          </span>
        </div>
        ${renderTrendSVG(tl, 92)}
      </div>`;
  } else if (availErr) {
    sparkHTML = `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="name-sub">24h trend unavailable (${esc(availErr)})</span><button class="btn btn-sm" onclick="S.ovTrendCache.ts=0;loadOverview()">Retry</button></div>`;
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

/* Overview Live Metrics Widget (6h perf_data sparklines right on Overview) */
function onOvMetricTargetChange(val) {
  S.ovMetricTarget = val || '';
  try { localStorage.setItem('encore-ov-metric-target', S.ovMetricTarget); } catch (e) {}
  renderOverviewLiveMetrics();
}

function openOvMetricFull() {
  const val = document.getElementById('ov-metric-target')?.value || S.ovMetricTarget || '';
  if (val.includes('||')) {
    const [h, svc] = val.split('||');
    if (typeof openMetricsFor === 'function') { openMetricsFor(h, svc); return; }
  }
  setView('reports', 'metrics');
}

async function renderOverviewLiveMetrics() {
  const box = document.getElementById('ov-live-metrics');
  const sel = document.getElementById('ov-metric-target');
  if (!box || !sel) return;
  const st = loadOvLayout();
  if (st.hidden.includes('metrics')) return;

  const nowMs = Date.now();
  if (!S.ovMetricTargetsCache.items.length || nowMs - S.ovMetricTargetsCache.ts > 60000) {
    try {
      const d = await apiFetchJSON('/api/v1/services?limit=200');
      const all = (d.services || []);
      const withPerf = all.filter(s => s.perf_data && s.perf_data.trim().length > 0);
      const list = (withPerf.length ? withPerf : all).slice(0, 60);
      S.ovMetricTargetsCache = { ts: nowMs, items: list };
      const cur = S.ovMetricTarget;
      sel.innerHTML = list.length
        ? list.map(s => {
            const v = `${s.host_name}||${s.description}`;
            return `<option value="${esc(v)}">${esc(s.host_name)} / ${esc(s.description)}</option>`;
          }).join('')
        : '<option value="">No metric services</option>';
      if (cur && list.some(s => `${s.host_name}||${s.description}` === cur)) {
        sel.value = cur;
      } else if (list.length) {
        S.ovMetricTarget = `${list[0].host_name}||${list[0].description}`;
        sel.value = S.ovMetricTarget;
      }
    } catch (e) {
      box.innerHTML = `<div class="name-sub">Unable to load metric targets: ${esc(e.message)}</div>`;
      return;
    }
  }

  const target = sel.value || S.ovMetricTarget;
  if (!target || !target.includes('||')) {
    box.innerHTML = `<div class="empty" style="padding:18px">No services with performance metrics found yet.</div>`;
    return;
  }
  const [host, service] = target.split('||');
  try {
    const qs = new URLSearchParams({ host, service, range: '6h' });
    const data = await apiFetchJSON('/api/v1/metrics?' + qs);
    const series = (data.series || []).slice(0, 2);
    if (!series.length) {
      box.innerHTML = `<div class="empty" style="padding:18px">No time-series samples recorded yet for <b>${esc(host)} / ${esc(service)}</b>.</div>`;
      return;
    }
    box.innerHTML = `<div class="metric-grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">${series.map(ser => `
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:11px 13px;background:var(--bg)">
        <div class="chart-title" style="margin-bottom:6px">
          <span>${esc(ser.label)}${ser.unit ? ` (${esc(ser.unit)})` : ''}</span>
          <span class="mono" style="color:var(--accent);font-weight:700">${ser.last}${esc(ser.unit || '')}</span>
        </div>
        ${renderMetricChartSVG(ser, { width: 460, height: 145 })}
        <div class="metric-stats" style="margin-top:6px">
          <span>Min <b>${ser.min}${esc(ser.unit || '')}</b></span>
          <span>Avg <b>${ser.avg}${esc(ser.unit || '')}</b></span>
          <span>Max <b>${ser.max}${esc(ser.unit || '')}</b></span>
        </div>
      </div>`).join('')}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="name-sub">Failed to load metrics: ${esc(e.message)}</div>`;
  }
}

async function loadOverview() {
  const sum = S.summary;
  if (!sum) return;
  const hPct = sum.hosts.total ? Math.round((sum.hosts.up / sum.hosts.total) * 100) : 100;
  const sPct = sum.services.total ? Math.round((sum.services.ok / sum.services.total) * 100) : 100;
  const unhand = sum.hosts.unhandled + sum.services.unhandled;
  const unhandCrit = (sum.hosts.unhandled_down ?? sum.hosts.down) + (sum.services.unhandled_critical ?? sum.services.critical);
  const hasCritUnhandled = unhand > 0 && unhandCrit > 0;
  const hasWarnOnlyUnhandled = unhand > 0 && !hasCritUnhandled;

  document.getElementById('ov-h-pct').textContent = hPct + '%';
  document.getElementById('ov-h-up').textContent = sum.hosts.up + ' UP';
  const hDownEl = document.getElementById('ov-h-down');
  if (hDownEl) {
    hDownEl.textContent = sum.hosts.down + ' DOWN';
    hDownEl.style.color = sum.hosts.down > 0 ? 'var(--crit-fg)' : '';
  }
  document.getElementById('ov-h-tot').textContent = sum.hosts.total + ' total';
  const hLed = document.getElementById('kpi-h-led');
  if (hLed) hLed.className = 'kpi-led ' + (sum.hosts.down > 0 ? 'crit' : (sum.hosts.unreachable > 0 ? 'warn' : ''));

  document.getElementById('ov-s-pct').textContent = sPct + '%';
  document.getElementById('ov-s-ok').textContent = sum.services.ok + ' OK';
  const sWarnEl = document.getElementById('ov-s-warn');
  if (sWarnEl) {
    sWarnEl.textContent = sum.services.warning + ' WARN';
    sWarnEl.style.color = sum.services.warning > 0 ? 'var(--warn-fg)' : '';
  }
  const sCritEl = document.getElementById('ov-s-crit');
  if (sCritEl) {
    sCritEl.textContent = sum.services.critical + ' CRIT';
    sCritEl.style.color = sum.services.critical > 0 ? 'var(--crit-fg)' : '';
  }
  const sLed = document.getElementById('kpi-s-led');
  if (sLed) sLed.className = 'kpi-led ' + (sum.services.critical > 0 ? 'crit' : (sum.services.warning > 0 ? 'warn' : ''));

  document.getElementById('ov-unhandled').textContent = unhand;
  document.getElementById('ov-u-sub').textContent = unhand > 0 ? `${sum.hosts.unhandled} hosts · ${sum.services.unhandled} services` : 'All clear';
  const uLed = document.getElementById('kpi-u-led');
  if (uLed) uLed.className = 'kpi-led ' + (hasCritUnhandled ? 'crit' : (hasWarnOnlyUnhandled ? 'warn' : ''));
  const uCard = document.getElementById('kpi-unhandled-card');
  if (uCard) {
    uCard.classList.toggle('is-alert', hasCritUnhandled);
    uCard.classList.toggle('is-warn', hasWarnOnlyUnhandled);
  }

  // Operational Readiness / Incident / Warning Command Strip
  const rb = document.getElementById('ov-readiness-banner');
  if (rb) {
    rb.classList.toggle('is-incident', hasCritUnhandled);
    rb.classList.toggle('is-warning', hasWarnOnlyUnhandled);
    if (hasCritUnhandled) {
      rb.innerHTML = `<div class="rb-body">
        <div class="rb-lead">
          <div class="rb-badge crit">${uiIcon('alert', 'lg')}</div>
          <div>
            <div class="rb-title" style="color:var(--crit-fg)">Active Incident — ${unhand} Unhandled Problem${unhand===1?'':'s'} Requiring Attention</div>
            <div class="rb-sub">${sum.hosts.down} host(s) down · ${sum.services.critical} critical · ${sum.services.warning} warning · Review the priority queue below.</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm danger" onclick="quickUnhandled()">Open Problems Queue</button>
          <button class="btn btn-sm" onclick="setView('inventory','byhost')">Inspect By Host</button>
          <button class="btn btn-sm" onclick="toggleOverviewLayoutEdit()">Layout</button>
        </div>
      </div>`;
    } else if (hasWarnOnlyUnhandled) {
      const warnParts = [];
      if (sum.services.warning > 0) warnParts.push(`${sum.services.warning} warning`);
      if (sum.services.unknown > 0) warnParts.push(`${sum.services.unknown} unknown`);
      if (sum.hosts.unreachable > 0) warnParts.push(`${sum.hosts.unreachable} unreachable`);
      rb.innerHTML = `<div class="rb-body">
        <div class="rb-lead">
          <div class="rb-badge warn">${uiIcon('alert', 'lg')}</div>
          <div>
            <div class="rb-title" style="color:var(--warn-fg)">Active Warning — ${unhand} Unhandled Warning${unhand===1?'':'s'} to Review</div>
            <div class="rb-sub">${warnParts.join(' · ') || `${unhand} warning(s)`} · No critical outages detected.</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm warn" onclick="quickUnhandled()">Review Warnings</button>
          <button class="btn btn-sm" onclick="setView('inventory','byhost')">Inspect By Host</button>
          <button class="btn btn-sm" onclick="toggleOverviewLayoutEdit()">Layout</button>
        </div>
      </div>`;
    } else {
      rb.innerHTML = `<div class="rb-body">
        <div class="rb-lead">
          <div class="rb-badge ok">${uiIcon('ok', 'lg')}</div>
          <div>
            <div class="rb-title">Fleet Nominal — All Monitored Systems Clear</div>
            <div class="rb-sub">${sum.hosts.up}/${sum.hosts.total} hosts UP · ${sum.services.ok}/${sum.services.total} services OK · Real-time SSE telemetry active.</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="setView('inventory','byhost')">Browse Inventory</button>
          <button class="btn btn-sm primary" onclick="setView('reports','sla')">SLA Reports</button>
          <button class="btn btn-sm" onclick="toggleOverviewLayoutEdit()">Layout</button>
        </div>
      </div>
      <div class="rb-art"><img src="/assets/scenes/fleet-calm.jpg" alt=""></div>`;
    }
  }

  // Apply unified 12-col widget order, spans, visibility & auto-pin
  const probPanel = document.getElementById('ov-prob-panel');
  if (probPanel) {
    probPanel.classList.toggle('panel-alert', hasCritUnhandled);
    probPanel.classList.toggle('panel-warn', hasWarnOnlyUnhandled);
  }
  applyOvLayout(unhand);

  try {
    const [pData, phData, aData, fhData] = await Promise.all([
      apiFetchJSON('/api/v1/services?unhandled=1&sort=severity&limit=10'),
      apiFetchJSON('/api/v1/hosts?unhandled=1&limit=10'),
      isAdmin() ? apiFetchJSON('/api/v1/audit?limit=5').catch(() => ({ entries: [] })) : Promise.resolve({ entries: [] }),
      apiFetchJSON('/api/v1/hosts/health')
    ]);
    const probs = pData.services || [];
    const probHosts = phData.hosts || [];
    const fleetHosts = fhData.hosts || [];

    renderOverviewFleetMap(fleetHosts);
    renderOverviewMiniCharts(sum);
    renderOverviewLiveMetrics();

    const pBody = document.getElementById('ov-prob-body');
    if (!probs.length && !probHosts.length) {
      pBody.innerHTML = `<tr><td colspan="5"><div class="art-empty">${artSVG('radar-ok')}<h4>All Systems Operational</h4><p>No unhandled problems at this time.</p></div></td></tr>`;
    } else {
      const hostRows = probHosts.map(h => {
        const key = regDrawerObj('host:' + h.name, h);
        return `
        <tr class="clickable" tabindex="0" onclick="openHostDrawerByKey('${jsEsc(key)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openHostDrawerByKey('${jsEsc(key)}');}">
          <td>${hostBadge(h)}</td>
          <td><div class="host-name-wrap">${hostIconBadge(h, 'sm')}<div><div class="name-primary">${esc(h.name)}${flagsHTML(h)}</div><div class="name-sub">Host · ${esc(h.address)}</div></div></div></td>
          <td class="mono">${durStr(h.last_state_change)}</td>
          <td class="output-cell" title="${esc(h.plugin_output)}">${esc(h.plugin_output || '-')}</td>
          <td class="actions" onclick="event.stopPropagation()">
            ${canOperate() ? `
              <button class="icon-btn" title="Force check host" aria-label="Force check ${esc(h.name)}" onclick="sendCmd('SCHEDULE_FORCED_HOST_CHECK;${jsEsc(h.name)};'+Math.floor(Date.now()/1000),'Force check host',this)">${uiIcon('refresh')}</button>
              <button class="icon-btn" title="Acknowledge host" aria-label="Acknowledge ${esc(h.name)}" onclick="openAckModal('host','${jsEsc(h.name)}','')">${uiIcon('check')}</button>
            ` : `<span class="name-sub">Read-only</span>`}
          </td>
        </tr>`;
      }).join('');
      const svcRows = probs.map(s => {
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
      pBody.innerHTML = hostRows + svcRows;
    }

    document.getElementById('ov-hg-list').innerHTML = S.hostgroups.length ? S.hostgroups.slice(0, 6).map(g => {
      const t = g.services.total || 1;
      return `<button type="button" class="gcard" style="margin-bottom:8px;padding:10px 12px" onclick="jumpToGroup('hg','${jsEsc(g.group_name)}')">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
          <b>${esc(g.group_name)}</b><span class="mono">${g.hosts.up}/${g.hosts.total} UP · ${g.services.ok}/${g.services.total} OK</span>
        </div>
        <div class="bar"><div class="bar-ok" style="width:${(g.services.ok/t)*100}%"></div><div class="bar-warn" style="width:${(g.services.warning/t)*100}%"></div><div class="bar-crit" style="width:${(g.services.critical/t)*100}%"></div></div>
      </button>`;
    }).join('') + (S.hostgroups.length > 6 ? `<div class="name-sub" style="text-align:right;margin-top:4px">Showing 6 of ${S.hostgroups.length} hostgroups</div>` : '') : '<div class="empty" style="padding:14px">No hostgroups defined</div>';

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
          ${hostIconBadge({ ...h, hostgroups: g.hostgroups }, 'md')}
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
          <td><div class="host-name-wrap">${hostIconBadge(h, 'sm')}<div><div class="name-primary">${esc(h.name)}${flagsHTML(h)}</div><div class="name-sub">${esc(h.address)}</div></div></div></td>
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
    <div class="panel"><div class="panel-head"><div class="panel-title"><svg class="panel-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1.8" fill="currentColor" fill-opacity="0.14"/><rect x="13" y="4" width="8" height="7" rx="1.8" fill="currentColor" fill-opacity="0.14"/><rect x="8" y="13.5" width="8" height="6.5" rx="1.8" fill="currentColor" fill-opacity="0.14"/></svg>Hostgroups</div></div><div class="group-grid">${hgCards}</div></div>
    <div class="panel"><div class="panel-head"><div class="panel-title"><svg class="panel-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" fill-opacity="0.14"/><path d="M9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/></svg>Servicegroups</div></div><div class="group-grid">${sgCards}</div></div>`;
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
  const icMeta = resolveHostIcon(h.icon, h.name, h.hostgroups);
  document.getElementById('drawer-body').innerHTML = `
    <div class="drawer-head">
      <div style="display:flex;align-items:flex-start;gap:12px">
        ${hostIconBadge(h, 'lg')}
        <div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${hostBadge(h)} ${flagsHTML(h)} <span class="flag-tag">${esc(icMeta.label)}</span></div>
          <h2 style="margin-top:6px">${esc(h.name)}</h2>
          <div class="name-sub">${esc(h.address)}</div>
        </div>
      </div>
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
