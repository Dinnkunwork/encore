let repHostsCache = [];
let repSvcsCache = [];

function setReportTab(t) {
  S.repTab = t;
  ['sla','metrics','alerts','eventlog'].forEach(k => document.getElementById('rtab-' + k)?.classList.toggle('active', k === t));
  loadReports();
}

async function openMetricsFor(host, service) {
  setView('reports', 'metrics');
  await syncReportDropdowns();
  const hSel = document.getElementById('rep-host');
  const sSel = document.getElementById('rep-svc');
  if (hSel) hSel.value = host || '';
  populateRepServicesForHost(host || '');
  if (sSel) sSel.value = service || '';
  loadReports();
}

/* Interactive Pure SVG Area + Line Metric Chart with Hover Crosshair & Tooltip */
window._mcRegistry = window._mcRegistry || {};

function onMetricChartMove(ev, id) {
  const meta = window._mcRegistry[id];
  if (!meta || !meta.pts.length) return;
  const wrap = document.getElementById('mc-wrap-' + id);
  const svg = document.getElementById('mc-svg-' + id);
  const tt = document.getElementById('mc-tt-' + id);
  const cross = document.getElementById('mc-cross-' + id);
  const dot = document.getElementById('mc-dot-' + id);
  const halo = document.getElementById('mc-halo-' + id);
  if (!wrap || !svg || !tt) return;

  const rect = svg.getBoundingClientRect();
  const relX = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * meta.w;
  const clampedX = Math.max(meta.padL, Math.min(meta.w - meta.padR, relX));
  // Find nearest sample point by X
  let best = meta.pts[0], bestDist = Infinity;
  for (const p of meta.pts) {
    const d = Math.abs(p.x - clampedX);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (cross) { cross.setAttribute('x1', best.x.toFixed(1)); cross.setAttribute('x2', best.x.toFixed(1)); cross.style.display = ''; }
  if (dot) { dot.setAttribute('cx', best.x.toFixed(1)); dot.setAttribute('cy', best.y.toFixed(1)); dot.style.display = ''; }
  if (halo) { halo.setAttribute('cx', best.x.toFixed(1)); halo.setAttribute('cy', best.y.toFixed(1)); halo.style.display = ''; }

  let statusTag = '';
  if (meta.crit != null && best.v >= meta.crit) statusTag = ' <span style="color:#f87171;font-weight:700">CRIT</span>';
  else if (meta.warn != null && best.v >= meta.warn) statusTag = ' <span style="color:#fbbf24;font-weight:700">WARN</span>';

  const dtStr = new Date(best.ts * 1000).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  tt.innerHTML = `<div class="tt-time">${esc(dtStr)}</div><div class="tt-val">${best.v}${esc(meta.unit)}${statusTag}</div>`;
  const leftPx = (best.x / meta.w) * rect.width;
  const topPx = (best.y / meta.h) * rect.height;
  const clampedLeft = Math.max(66, Math.min(rect.width - 66, leftPx));
  tt.style.left = clampedLeft + 'px';
  tt.style.top = Math.max(44, topPx) + 'px';
  tt.style.display = 'block';
}

function onMetricChartLeave(id) {
  const tt = document.getElementById('mc-tt-' + id);
  const cross = document.getElementById('mc-cross-' + id);
  const dot = document.getElementById('mc-dot-' + id);
  const halo = document.getElementById('mc-halo-' + id);
  if (tt) tt.style.display = 'none';
  if (cross) cross.style.display = 'none';
  if (dot) dot.style.display = 'none';
  if (halo) halo.style.display = 'none';
}

function renderMetricChartSVG(ser, opts = {}) {
  const pts = ser.points || [];
  if (!pts.length) return '<div class="empty" style="padding:16px">No samples yet</div>';
  const w = opts.width || 560, h = opts.height || 210, padL = 50, padR = 16, padT = 18, padB = 26;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  let minY = ser.min, maxY = ser.max;
  if (ser.warn != null && ser.warn > maxY && ser.warn < maxY * 3 + 100) maxY = Math.max(maxY, ser.warn);
  if (ser.crit != null && ser.crit > maxY && ser.crit < maxY * 3 + 100) maxY = Math.max(maxY, ser.crit);
  if (minY > 0 && minY < maxY * 0.25) minY = 0;
  if (maxY <= minY) maxY = minY + 1;
  const minT = pts[0].ts, maxT = Math.max(pts[pts.length - 1].ts, minT + 1);

  const sx = ts => padL + ((ts - minT) / (maxT - minT)) * plotW;
  const sy = v => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;

  const mapped = pts.map(p => ({ ts: p.ts, v: p.v, x: sx(p.ts), y: sy(p.v) }));
  const coords = mapped.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  const lineD = mapped.length === 1 ? `M ${padL},${mapped[0].y.toFixed(1)} L ${w - padR},${mapped[0].y.toFixed(1)}` : 'M ' + coords.join(' L ');
  const areaD = mapped.length === 1
    ? `${lineD} L ${w - padR},${padT + plotH} L ${padL},${padT + plotH} Z`
    : `${lineD} L ${mapped[mapped.length - 1].x.toFixed(1)},${padT + plotH} L ${mapped[0].x.toFixed(1)},${padT + plotH} Z`;

  const chartId = Math.random().toString(36).slice(2, 10);
  window._mcRegistry[chartId] = { w, h, padL, padR, unit: ser.unit || '', warn: ser.warn, crit: ser.crit, pts: mapped };
  const gradId = 'mg-' + chartId;
  let threshHTML = '';
  if (ser.warn != null && ser.warn >= minY && ser.warn <= maxY) {
    const wy = sy(ser.warn).toFixed(1);
    threshHTML += `<line x1="${padL}" y1="${wy}" x2="${w - padR}" y2="${wy}" stroke="var(--warn)" stroke-width="1.3" stroke-dasharray="4 3"/><text x="${w - padR - 2}" y="${(Number(wy) - 4).toFixed(1)}" text-anchor="end" fill="var(--warn-fg)" font-size="10" font-weight="600">WARN ${ser.warn}</text>`;
  }
  if (ser.crit != null && ser.crit >= minY && ser.crit <= maxY) {
    const cy = sy(ser.crit).toFixed(1);
    threshHTML += `<line x1="${padL}" y1="${cy}" x2="${w - padR}" y2="${cy}" stroke="var(--crit)" stroke-width="1.3" stroke-dasharray="4 3"/><text x="${w - padR - 2}" y="${(Number(cy) - 4).toFixed(1)}" text-anchor="end" fill="var(--crit-fg)" font-size="10" font-weight="600">CRIT ${ser.crit}</text>`;
  }
  const dots = mapped.length <= 45 ? mapped.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="var(--accent)"/>`).join('') : '';
  const tStart = new Date(minT * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tMid = new Date(((minT + maxT) / 2) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tEnd = new Date(maxT * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `<div class="chart-interactive" id="mc-wrap-${chartId}" onmousemove="onMetricChartMove(event,'${chartId}')" onmouseleave="onMetricChartLeave('${chartId}')">
    <div class="chart-tooltip" id="mc-tt-${chartId}"></div>
    <svg id="mc-svg-${chartId}" viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block;cursor:crosshair">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0.03"/></linearGradient></defs>
      <line x1="${padL}" y1="${padT}" x2="${w-padR}" y2="${padT}" stroke="var(--border)" stroke-dasharray="3 3"/>
      <line x1="${padL}" y1="${padT + plotH/2}" x2="${w-padR}" y2="${padT + plotH/2}" stroke="var(--border)" stroke-dasharray="3 3"/>
      <line x1="${padL}" y1="${padT + plotH}" x2="${w-padR}" y2="${padT + plotH}" stroke="var(--border)"/>
      <text x="${padL-6}" y="${padT+4}" text-anchor="end" fill="var(--muted)" font-size="10.5">${maxY.toFixed(1)}</text>
      <text x="${padL-6}" y="${padT+plotH/2+4}" text-anchor="end" fill="var(--muted)" font-size="10.5">${((maxY+minY)/2).toFixed(1)}</text>
      <text x="${padL-6}" y="${padT+plotH+3}" text-anchor="end" fill="var(--muted)" font-size="10.5">${minY.toFixed(1)}</text>
      <text x="${padL}" y="${h-6}" fill="var(--muted)" font-size="10.5">${tStart}</text>
      <text x="${padL + plotW/2}" y="${h-6}" text-anchor="middle" fill="var(--muted)" font-size="10.5">${tMid}</text>
      <text x="${w-padR}" y="${h-6}" text-anchor="end" fill="var(--muted)" font-size="10.5">${tEnd}</text>
      <path d="${areaD}" fill="url(#${gradId})"/>
      <path d="${lineD}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      ${threshHTML}${dots}
      <line id="mc-cross-${chartId}" x1="0" y1="${padT}" x2="0" y2="${padT+plotH}" stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="3 3" style="display:none"/>
      <circle id="mc-halo-${chartId}" cx="0" cy="0" r="9" fill="var(--accent)" fill-opacity="0.22" style="display:none"/>
      <circle id="mc-dot-${chartId}" cx="0" cy="0" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" style="display:none"/>
    </svg>
  </div>`;
}

function setReportRange(r) {
  S.repRange = r;
  ['24h','7d','30d','custom'].forEach(k => document.getElementById('rr-' + k)?.classList.toggle('active', k === r));
  const cd = document.getElementById('rep-custom-dates');
  if (cd) {
    cd.style.display = r === 'custom' ? 'flex' : 'none';
    if (r === 'custom') {
      const f = document.getElementById('rep-from'), t = document.getElementById('rep-to');
      if (!t.value) t.value = new Date().toISOString().slice(0, 10);
      if (!f.value) f.value = new Date(Date.now() - 7*86400000).toISOString().slice(0, 10);
    }
  }
  loadReports();
}

function toggleRepGroupByHost() {
  S.repGroupByHost = !S.repGroupByHost;
  document.getElementById('rep-group-btn')?.classList.toggle('active', S.repGroupByHost);
  loadReports();
}

function getReportBounds() {
  const now = Math.floor(Date.now() / 1000);
  if (S.repRange === 'custom') {
    const fVal = document.getElementById('rep-from')?.value;
    const tVal = document.getElementById('rep-to')?.value;
    const from = fVal ? Math.floor(new Date(fVal + 'T00:00:00').getTime() / 1000) : now - 7*86400;
    const to = tVal ? Math.floor(new Date(tVal + 'T23:59:59').getTime() / 1000) : now;
    return { from, to: Math.max(to, from + 3600) };
  }
  const map = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
  return { from: now - (map[S.repRange] || 86400), to: now };
}

async function openReportFor(host, service) {
  setView('reports', 'sla');
  await syncReportDropdowns();
  const hSel = document.getElementById('rep-host');
  const sSel = document.getElementById('rep-svc');
  const tSel = document.getElementById('rep-target');
  if (tSel) tSel.value = service ? 'services' : 'services';
  if (hSel) hSel.value = host || '';
  populateRepServicesForHost(host || '');
  if (sSel) sSel.value = service || '';
  loadReports();
}

async function syncReportDropdowns() {
  const hgSel = document.getElementById('rep-hg');
  if (hgSel && hgSel.options.length <= 1 && S.hostgroups.length) {
    hgSel.innerHTML = '<option value="">All Hostgroups</option>' + S.hostgroups.map(g => `<option value="${esc(g.group_name)}">${esc(g.group_name)}</option>`).join('');
  }
  const hSel = document.getElementById('rep-host');
  if (hSel && repHostsCache.length === 0) {
    try {
      const [hr, sr] = await Promise.all([fetch('/api/v1/hosts?limit=500'), fetch('/api/v1/services?limit=1000')]);
      repHostsCache = (await hr.json()).hosts || [];
      repSvcsCache = (await sr.json()).services || [];
      const curH = hSel.value;
      hSel.innerHTML = '<option value="">All Hosts</option>' + repHostsCache.map(h => `<option value="${esc(h.name)}">${esc(h.name)}</option>`).join('');
      if (curH) hSel.value = curH;
      populateRepServicesForHost(hSel.value);
    } catch (e) {}
  }
}

function populateRepServicesForHost(hostName) {
  const sSel = document.getElementById('rep-svc');
  if (!sSel) return;
  const cur = sSel.value;
  const names = [...new Set(repSvcsCache.filter(s => !hostName || s.host_name === hostName).map(s => s.description))].sort();
  sSel.innerHTML = '<option value="">All Services</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (names.includes(cur)) sSel.value = cur;
}

function onReportHostChange() {
  const host = document.getElementById('rep-host')?.value || '';
  populateRepServicesForHost(host);
  loadReports();
}
function onReportFilterChange() { loadReports(); }

function exportReport(fmt) {
  const { from, to } = getReportBounds();
  const target = document.getElementById('rep-target')?.value || 'services';
  const hg = document.getElementById('rep-hg')?.value || '';
  const host = document.getElementById('rep-host')?.value || '';
  const service = document.getElementById('rep-svc')?.value || '';
  const qs = new URLSearchParams({ from, to, target, format: fmt });
  if (hg) qs.set('hostgroup', hg);
  if (host) qs.set('host', host);
  if (service && target === 'services') qs.set('service', service);
  const url = '/api/v1/reports/export?' + qs.toString();
  if (fmt === 'html') window.open(url, '_blank');
  else window.location.href = url;
}

/* Pure SVG Donut Chart */
function renderDonutSVG(sum) {
  const ok = Math.max(0, sum.overall_sla_pct ?? 100);
  const warn = Math.max(0, sum.warn_pct || 0);
  const crit = Math.max(0, sum.crit_pct || 0);
  const unk = Math.max(0, sum.unk_pct || 0);
  const r = 42, c = 2 * Math.PI * r;
  const segs = [
    { pct: ok, color: 'var(--ok)', label: 'UP / OK' },
    { pct: warn, color: 'var(--warn)', label: 'WARNING' },
    { pct: crit, color: 'var(--crit)', label: 'CRIT / DOWN' },
    { pct: unk, color: 'var(--unk)', label: 'UNKNOWN' }
  ];
  let off = 0;
  const circles = segs.filter(s => s.pct > 0).map(s => {
    const len = (s.pct / 100) * c;
    const out = `<circle cx="56" cy="56" r="${r}" fill="none" stroke="${s.color}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 56 56)"/>`;
    off += len;
    return out;
  }).join('');
  return `
    <div class="donut-wrap">
      <svg width="112" height="112" viewBox="0 0 112 112" style="flex-shrink:0">
        <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="14"/>
        ${circles}
        <text x="56" y="54" text-anchor="middle" fill="var(--text)" font-size="16" font-weight="700">${ok.toFixed(1)}%</text>
        <text x="56" y="68" text-anchor="middle" fill="var(--muted)" font-size="9.5">SLA</text>
      </svg>
      <div class="donut-legend">
        ${segs.map(s => `<div class="legend-row"><span><span class="legend-dot" style="background:${s.color}"></span>${s.label}</span><b class="mono">${s.pct.toFixed(2)}%</b></div>`).join('')}
        <div class="legend-row" style="border-top:1px solid var(--border);padding-top:4px;margin-top:2px"><span class="name-sub">Downtime</span><span class="mono">${(sum.downtime_pct||0).toFixed(2)}%</span></div>
      </div>
    </div>`;
}

/* Interactive Pure SVG Uptime & Incident Trend Bar Chart */
window._trRegistry = window._trRegistry || {};

function onTrendBarEnter(ev, id, idx) {
  const meta = window._trRegistry[id];
  if (!meta || !meta.items[idx]) return;
  const tt = document.getElementById('tr-tt-' + id);
  const svg = document.getElementById('tr-svg-' + id);
  if (!tt || !svg) return;
  const b = meta.items[idx];
  const rect = svg.getBoundingClientRect();
  const leftPx = (b.cx / meta.w) * rect.width;
  const clampedLeft = Math.max(76, Math.min(rect.width - 76, leftPx));
  const col = b.ok_pct >= 99.5 ? '#34d399' : (b.ok_pct >= 95 ? '#fbbf24' : '#f87171');
  const probDetails = (b.crit_pct || b.warn_pct) ? `<div style="font-size:11px;color:#cbd5e1">Warn: ${(b.warn_pct||0).toFixed(1)}% • Crit/Down: ${(b.crit_pct||0).toFixed(1)}%</div>` : '';
  tt.innerHTML = `<div class="tt-time">Window: ${esc(b.label)}</div><div class="tt-val" style="color:${col}">Uptime ${b.ok_pct.toFixed(2)}%</div>${probDetails}<div style="font-size:11px;color:${b.incidents>0?'#f87171':'#94a3b8'}">${b.incidents} HARD incident(s)</div>`;
  tt.style.left = clampedLeft + 'px';
  tt.style.top = '42px';
  tt.style.display = 'block';
}
function onTrendLeave(id) {
  const tt = document.getElementById('tr-tt-' + id);
  if (tt) tt.style.display = 'none';
}

function renderTrendSVG(timeline, height = 152) {
  if (!timeline || !timeline.length) return '<div class="empty" style="padding:24px">No timeline data</div>';
  const w = 640, h = height, padL = 36, padB = 22, padT = 14, padR = 8;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const n = timeline.length;
  const step = plotW / n;
  const barW = Math.max(5, Math.min(28, step * 0.72));
  const labelEvery = n > 14 ? Math.ceil(n / 10) : 1;
  const tid = Math.random().toString(36).slice(2, 10);
  const items = [];

  const bars = timeline.map((b, i) => {
    const x = padL + i * step + (step - barW) / 2;
    const cx = x + barW / 2;
    const bh = Math.max(3, (b.ok_pct / 100) * plotH);
    const y = padT + (plotH - bh);
    const col = b.ok_pct >= 99.5 ? 'var(--ok)' : (b.ok_pct >= 95 ? 'var(--warn)' : 'var(--crit)');
    const incDot = b.incidents > 0 ? `<circle cx="${cx.toFixed(1)}" cy="${Math.max(padT + 4, y - 5).toFixed(1)}" r="3.8" fill="var(--crit)" stroke="var(--surface)" stroke-width="1"/>` : '';
    const lbl = (i % labelEvery === 0 || i === n - 1) ? `<text x="${cx.toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="var(--muted)" font-size="9.5">${esc(b.label)}</text>` : '';
    items.push({ ...b, cx });
    return `<g class="chart-bar-g" onmouseenter="onTrendBarEnter(event,'${tid}',${i})">
      <rect class="chart-bar-bg" x="${x.toFixed(1)}" y="${padT}" width="${barW.toFixed(1)}" height="${plotH}" rx="3" fill="var(--surface-2)"/>
      <rect class="chart-bar-fg" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${col}"/>
      ${incDot}${lbl}
    </g>`;
  }).join('');

  window._trRegistry[tid] = { w, h, items };

  return `<div class="chart-interactive" onmouseleave="onTrendLeave('${tid}')">
    <div class="chart-tooltip" id="tr-tt-${tid}"></div>
    <svg id="tr-svg-${tid}" viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
      <line x1="${padL}" y1="${padT}" x2="${w-padR}" y2="${padT}" stroke="var(--ok)" stroke-opacity="0.45" stroke-dasharray="4 3"/>
      <line x1="${padL}" y1="${padT + plotH/2}" x2="${w-padR}" y2="${padT + plotH/2}" stroke="var(--border)" stroke-dasharray="3 3"/>
      <text x="${padL-4}" y="${padT+4}" text-anchor="end" fill="var(--ok-fg)" font-size="9.5">100%</text>
      <text x="${padL-4}" y="${padT+plotH/2+3}" text-anchor="end" fill="var(--muted)" font-size="9.5">50%</text>
      <text x="${padL-4}" y="${padT+plotH}" text-anchor="end" fill="var(--muted)" font-size="9.5">0%</text>
      ${bars}
    </svg>
  </div>`;
}

function toggleRepHost(h) {
  if (S.repExpandedHosts.has(h)) S.repExpandedHosts.delete(h);
  else S.repExpandedHosts.add(h);
  loadReports();
}

async function loadReports() {
  const el = document.getElementById('reports-content');
  await syncReportDropdowns();
  const { from, to } = getReportBounds();
  const target = document.getElementById('rep-target')?.value || 'services';
  const hg = document.getElementById('rep-hg')?.value || '';
  const host = document.getElementById('rep-host')?.value || '';
  const service = document.getElementById('rep-svc')?.value || '';

  const svcSel = document.getElementById('rep-svc');
  if (svcSel) svcSel.style.display = (S.repTab === 'sla' && target === 'hosts') ? 'none' : '';
  document.getElementById('rep-sla-controls').style.display = S.repTab === 'sla' ? 'flex' : 'none';

  if (S.repTab === 'sla') {
    const qs = new URLSearchParams({ from, to, target });
    if (hg) qs.set('hostgroup', hg);
    if (host) qs.set('host', host);
    if (service && target === 'services') qs.set('service', service);
    const data = await (await fetch('/api/v1/reports/availability?' + qs)).json();
    const sum = data.summary || {};
    const rows = data.rows || [];
    const timeline = data.timeline || [];

    let tableHTML = '';
    if (target === 'services' && S.repGroupByHost && !host) {
      // Group rows by Host
      const byHost = new Map();
      rows.forEach(r => {
        if (!byHost.has(r.host)) byHost.set(r.host, []);
        byHost.get(r.host).push(r);
      });
      const groups = [...byHost.entries()].map(([hName, list]) => {
        const avgOK = list.reduce((a, r) => a + r.ok_pct, 0) / list.length;
        const avgWarn = list.reduce((a, r) => a + r.warn_pct, 0) / list.length;
        const avgCrit = list.reduce((a, r) => a + r.crit_pct, 0) / list.length;
        const totInc = list.reduce((a, r) => a + r.incidents, 0);
        return { hName, list, avgOK, avgWarn, avgCrit, totInc };
      }).sort((a, b) => a.avgOK - b.avgOK);

      tableHTML = groups.length ? groups.map(g => {
        const open = S.repExpandedHosts.has(g.hName) || groups.length === 1;
        return `<div class="host-acc ${open?'open':''}">
          <div class="host-acc-head" onclick="toggleRepHost('${esc(g.hName)}')">
            <div class="host-acc-left">
              <span class="host-acc-chev">▶</span>
              <b>${esc(g.hName)}</b>
              <span class="flag-tag">${g.list.length} services</span>
              <span class="badge ${g.avgOK>=99?'c-ok':(g.avgOK>=95?'c-warn':'c-crit')}">Avg SLA ${g.avgOK.toFixed(2)}%</span>
              ${g.totInc > 0 ? `<span class="badge c-crit">${g.totInc} incidents</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:10px" onclick="event.stopPropagation()">
              <div style="width:120px"><div class="bar"><div class="bar-ok" style="width:${g.avgOK}%"></div><div class="bar-warn" style="width:${g.avgWarn}%"></div><div class="bar-crit" style="width:${g.avgCrit}%"></div></div></div>
              <button class="btn btn-sm" onclick="openReportFor('${esc(g.hName)}','')">Focus Host</button>
            </div>
          </div>
          <div class="host-acc-body">
            <div class="table-wrap"><table><thead><tr><th>Service</th><th>Uptime Bar</th><th>OK %</th><th>WARN %</th><th>CRIT %</th><th>Problem Time</th><th>Incidents</th><th>MTTR</th></tr></thead><tbody>
              ${g.list.map(r => `<tr>
                <td><a href="#" style="color:var(--accent);text-decoration:none;font-weight:600" onclick="openReportFor('${jsEsc(r.host)}','${jsEsc(r.service)}');return false">${esc(r.service)}</a></td>
                <td style="min-width:120px"><div class="bar"><div class="bar-ok" style="width:${r.ok_pct}%"></div><div class="bar-warn" style="width:${r.warn_pct}%"></div><div class="bar-crit" style="width:${r.crit_pct}%"></div></div></td>
                <td class="mono" style="color:var(--ok-fg);font-weight:700">${r.ok_pct.toFixed(2)}%</td>
                <td class="mono">${r.warn_pct.toFixed(2)}%</td>
                <td class="mono" style="color:${r.crit_pct>0?'var(--crit-fg)':'var(--muted)'}">${r.crit_pct.toFixed(2)}%</td>
                <td class="mono" style="color:${r.problem_sec>0?'var(--crit-fg)':'var(--muted)'}">${fmtDurationSec(r.problem_sec)}</td>
                <td class="mono">${r.incidents}</td>
                <td class="mono">${r.mttr_sec ? fmtDurationSec(r.mttr_sec) : '-'}</td>
              </tr>`).join('')}
            </tbody></table></div>
          </div>
        </div>`;
      }).join('') : '<div class="empty">No objects in selected scope</div>';
    } else {
      tableHTML = `<div class="table-wrap"><table><thead><tr><th>Host</th>${target==='services'?'<th>Service</th>':''}<th>Uptime Bar</th><th>UP/OK %</th><th>WARN %</th><th>CRIT/DOWN %</th><th>Problem Time</th><th>Incidents</th><th>MTTR</th></tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr>
          <td><b>${esc(r.host)}</b></td>
          ${target==='services'?`<td>${esc(r.service)}</td>`:''}
          <td style="min-width:130px"><div class="bar"><div class="bar-ok" style="width:${r.ok_pct}%"></div><div class="bar-warn" style="width:${r.warn_pct}%"></div><div class="bar-crit" style="width:${r.crit_pct}%"></div></div></td>
          <td class="mono" style="color:var(--ok-fg);font-weight:700">${r.ok_pct.toFixed(2)}%</td>
          <td class="mono">${r.warn_pct.toFixed(2)}%</td>
          <td class="mono" style="color:${r.crit_pct>0?'var(--crit-fg)':'var(--muted)'}">${r.crit_pct.toFixed(2)}%</td>
          <td class="mono" style="color:${r.problem_sec>0?'var(--crit-fg)':'var(--muted)'}">${fmtDurationSec(r.problem_sec)}</td>
          <td class="mono">${r.incidents}</td>
          <td class="mono">${r.mttr_sec ? fmtDurationSec(r.mttr_sec) : '-'}</td>
        </tr>`).join('') : '<tr><td colspan="9" class="empty">No objects in selected scope</td></tr>'}
      </tbody></table></div>`;
    }

    const scopeTag = [hg, host, service].filter(Boolean).join(' / ') || 'All Scope';
    const srcNote = sum.log_events_used > 0 ? `${sum.log_events_used} log events + live state` : 'Live state (0 alert transitions in window)';
    el.innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">Overall Uptime (SLA)</span><img class="kpi-icon" src="/assets/status/${sum.overall_sla_pct >= 99 ? 'status-ok.svg' : 'status-warn.svg'}"></div><div class="kpi-val">${(sum.overall_sla_pct ?? 100).toFixed(2)}%</div><div class="kpi-sub"><span>${sum.total_objects || 0} ${esc(target)} • ${esc(scopeTag)}</span></div></div>
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">HARD Incidents</span><img class="kpi-icon" src="/assets/icons/alert.svg"></div><div class="kpi-val">${sum.total_incidents || 0}</div><div class="kpi-sub"><span>Total problem time: <b>${fmtDurationSec(sum.total_problem_sec)}</b></span></div></div>
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">Avg Recovery (MTTR)</span><img class="kpi-icon" src="/assets/icons/bell.svg"></div><div class="kpi-val">${sum.avg_mttr_sec ? fmtDurationSec(sum.avg_mttr_sec) : '0s'}</div><div class="kpi-sub"><span>Source: ${esc(srcNote)}</span></div></div>
      </div>
      <div class="charts-row">
        <div class="chart-card">
          <div class="chart-title"><span>State Breakdown</span></div>
          ${renderDonutSVG(sum)}
        </div>
        <div class="chart-card">
          <div class="chart-title"><span>Uptime &amp; Incident Trend</span><span class="name-sub">Hover bar for details • Red dot = HARD incident</span></div>
          ${renderTrendSVG(timeline, 152)}
        </div>
      </div>
      <div class="panel">${tableHTML}</div>`;
  } else if (S.repTab === 'metrics') {
    const selHost = host || (repHostsCache[0] && repHostsCache[0].name) || '';
    const svcsForHost = repSvcsCache.filter(s => !selHost || s.host_name === selHost);
    const selSvc = service || (svcsForHost[0] && svcsForHost[0].description) || '';
    const mRange = (S.repRange === '7d' || S.repRange === '30d') ? '7d' : '24h';
    if (!selHost || !selSvc) {
      el.innerHTML = `<div class="panel"><div class="art-empty">${artSVG('search')}<h4>Select Host &amp; Service</h4><p>Pilih Host dan Service pada filter di atas untuk menampilkan grafik time-series metrik (CPU, RAM, Latency, dll).</p></div></div>`;
      return;
    }
    const qs = new URLSearchParams({ host: selHost, service: selSvc, range: mRange });
    const data = await (await fetch('/api/v1/metrics?' + qs)).json();
    const series = data.series || [];
    el.innerHTML = series.length ? `
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div class="name-primary">Metrics: ${esc(selHost)} / ${esc(selSvc)} <span class="flag-tag">${esc(mRange)}</span></div>
        <span class="name-sub">${series.length} metric series recorded from Encore perf_data</span>
      </div>
      <div class="metric-grid">${series.map(ser => `
        <div class="chart-card">
          <div class="chart-title"><span>${esc(ser.label)} ${ser.unit ? '(' + esc(ser.unit) + ')' : ''}</span><span class="mono">Last: <b>${ser.last}${esc(ser.unit||'')}</b></span></div>
          ${renderMetricChartSVG(ser)}
          <div class="metric-stats">
            <span>Min: <b>${ser.min}${esc(ser.unit||'')}</b></span>
            <span>Avg: <b>${ser.avg}${esc(ser.unit||'')}</b></span>
            <span>Max: <b>${ser.max}${esc(ser.unit||'')}</b></span>
            <span>Samples: <b>${(ser.points||[]).length}</b></span>
          </div>
        </div>`).join('')}
      </div>` : `<div class="panel"><div class="art-empty">${artSVG('servers')}<h4>No Time-Series Metrics Yet</h4><p>Belum ada data <code>perf_data</code> tercatat untuk <b>${esc(selHost)} / ${esc(selSvc)}</b>. Data akan terkumpul otomatis setiap kali check berjalan.</p></div></div>`;
  } else if (S.repTab === 'alerts') {
    const hardOnly = document.getElementById('rep-hard-only')?.checked ? '1' : '0';
    const qs = new URLSearchParams({ from, to, type: 'alerts', hard_only: hardOnly, limit: 150 });
    if (host) qs.set('host', host);
    if (service) qs.set('service', service);
    const data = await (await fetch('/api/v1/reports/events?' + qs)).json();
    const evs = data.events || [];
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Alert &amp; Notification History (${data.total || 0})</div>
          <label class="chk-pill"><input type="checkbox" id="rep-hard-only" ${hardOnly==='1'?'checked':''} onchange="loadReports()"> HARD Only</label>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Target</th><th>State</th><th>Output</th></tr></thead><tbody>
          ${evs.length ? evs.map(e => {
            const cls = (e.state==='OK'||e.state==='UP') ? 'c-ok' : (e.state==='WARNING'||e.state==='UNREACHABLE') ? 'c-warn' : (e.state==='CRITICAL'||e.state==='DOWN') ? 'c-crit' : 'c-unk';
            return `<tr>
              <td class="mono" style="white-space:nowrap">${new Date(e.timestamp*1000).toLocaleString()}</td>
              <td><span class="flag-tag">${esc(e.type)}</span>${e.state_type?` <span class="flag-tag">${esc(e.state_type)}</span>`:''}</td>
              <td><b>${esc(e.host)}</b>${e.service?`<div class="name-sub">${esc(e.service)}</div>`:''}</td>
              <td><span class="badge ${cls}">${esc(e.state||'-')}</span></td>
              <td class="output-cell" title="${esc(e.message)}">${esc(e.message)}</td>
            </tr>`;
          }).join('') : '<tr><td colspan="5" class="empty">No alerts recorded in this time range.</td></tr>'}
        </tbody></table></div>
      </div>`;
  } else {
    const qs = new URLSearchParams({ from, to, type: 'all', limit: 200 });
    if (host) qs.set('host', host);
    if (service) qs.set('service', service);
    const data = await (await fetch('/api/v1/reports/events?' + qs)).json();
    const evs = data.events || [];
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Encore Event Log (${data.total || 0} entries)</div></div>
        <div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Target</th><th>Message</th></tr></thead><tbody>
          ${evs.length ? evs.map(e => `<tr>
            <td class="mono" style="white-space:nowrap">${new Date(e.timestamp*1000).toLocaleString()}</td>
            <td><span class="flag-tag">${esc(e.type)}</span></td>
            <td class="mono">${esc(e.host || '-')} ${e.service ? '/ ' + esc(e.service) : ''}</td>
            <td class="mono" style="color:var(--text)">${esc(e.message)}</td>
          </tr>`).join('') : '<tr><td colspan="4" class="empty">No log entries found (check -encore-log path).</td></tr>'}
        </tbody></table></div>
      </div>`;
  }
}

/* ====== SCHEDULED SLA REPORT DIGEST ====== */
async function openDigestModal() {
  const res = await fetch('/api/v1/reports/digest');
  if (res.status === 403) { toast('Admin role required to configure Scheduled Digest'); return; }
  const d = (await res.json()).config || {};
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  openModal(`<h2>Scheduled SLA Report Digest</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill instant">Instant Save — menggunakan SMTP / Webhook dari Manage → Notifications</span></div>
    <div class="form-grid">
      <div class="form-row"><label>Frequency</label>
        <select id="dg-freq" onchange="document.getElementById('dg-day-row').style.display=this.value==='weekly'?'':'none'">
          <option value="weekly" ${d.frequency!=='daily'?'selected':''}>Weekly</option>
          <option value="daily" ${d.frequency==='daily'?'selected':''}>Daily</option>
        </select>
      </div>
      <div class="form-row" id="dg-day-row" style="${d.frequency==='daily'?'display:none':''}"><label>Day of Week</label>
        <select id="dg-day">${days.map((n,i)=>`<option value="${i}" ${(d.day_of_week??1)===i?'selected':''}>${n}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>Send Time (24h HH:MM)</label><input id="dg-time" type="text" value="${esc(d.send_time||'08:00')}"></div>
      <div class="form-row"><label>SLA Window (Days)</label>
        <select id="dg-win"><option value="1" ${d.window_days===1?'selected':''}>Last 24 Hours (1d)</option><option value="7" ${(d.window_days||7)===7?'selected':''}>Last 7 Days (7d)</option><option value="30" ${d.window_days===30?'selected':''}>Last 30 Days (30d)</option></select>
      </div>
      <div class="form-row full"><label>Hostgroup Filter (blank = All)</label><input id="dg-hg" type="text" value="${esc(d.hostgroup||'')}" placeholder="All infrastructure"></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
      <label class="chk-pill"><input type="checkbox" id="dg-en" ${d.enabled?'checked':''}> Enable Schedule</label>
      <label class="chk-pill"><input type="checkbox" id="dg-email" ${d.send_email!==false?'checked':''}> Send Email</label>
      <label class="chk-pill"><input type="checkbox" id="dg-wh" ${d.send_webhook?'checked':''}> Send Webhook</label>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn" onclick="sendDigestNow()">Send Now</button>
      <button class="btn primary" onclick="saveDigestConfig()">Save Schedule</button>
    </div>`);
}
async function saveDigestConfig() {
  const payload = {
    enabled: document.getElementById('dg-en').checked,
    frequency: document.getElementById('dg-freq').value,
    day_of_week: Number(document.getElementById('dg-day').value),
    send_time: document.getElementById('dg-time').value.trim(),
    window_days: Number(document.getElementById('dg-win').value) || 7,
    hostgroup: document.getElementById('dg-hg').value.trim(),
    send_email: document.getElementById('dg-email').checked,
    send_webhook: document.getElementById('dg-wh').checked
  };
  const res = await fetch('/api/v1/reports/digest', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const d = await res.json();
  toast(res.ok ? 'Digest schedule saved (instant)' : ('Error: ' + d.error));
  if (res.ok) closeModal();
}
async function sendDigestNow() {
  await saveDigestConfig();
  toast('Generating & sending SLA digest...');
  const res = await fetch('/api/v1/reports/digest/send-now', { method:'POST' });
  const d = await res.json();
  toast(res.ok ? `Digest sent via ${d.channels}` : ('Send failed: ' + d.error));
}
