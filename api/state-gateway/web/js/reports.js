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

/* Pure SVG Area + Line Metric Chart with WARN/CRIT threshold lines */
function renderMetricChartSVG(ser) {
  const pts = ser.points || [];
  if (!pts.length) return '<div class="empty" style="padding:16px">No samples yet</div>';
  const w = 520, h = 148, padL = 44, padR = 12, padT = 14, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  let minY = ser.min, maxY = ser.max;
  if (ser.warn != null && ser.warn > maxY && ser.warn < maxY * 3 + 100) maxY = Math.max(maxY, ser.warn);
  if (ser.crit != null && ser.crit > maxY && ser.crit < maxY * 3 + 100) maxY = Math.max(maxY, ser.crit);
  if (minY > 0 && minY < maxY * 0.25) minY = 0;
  if (maxY <= minY) maxY = minY + 1;
  const minT = pts[0].ts, maxT = Math.max(pts[pts.length - 1].ts, minT + 1);

  const sx = ts => padL + ((ts - minT) / (maxT - minT)) * plotW;
  const sy = v => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;

  const coords = pts.map(p => `${sx(p.ts).toFixed(1)},${sy(p.v).toFixed(1)}`);
  const lineD = pts.length === 1 ? `M ${padL},${sy(pts[0].v).toFixed(1)} L ${w - padR},${sy(pts[0].v).toFixed(1)}` : 'M ' + coords.join(' L ');
  const areaD = pts.length === 1
    ? `${lineD} L ${w - padR},${padT + plotH} L ${padL},${padT + plotH} Z`
    : `${lineD} L ${sx(pts[pts.length - 1].ts).toFixed(1)},${padT + plotH} L ${sx(pts[0].ts).toFixed(1)},${padT + plotH} Z`;

  const gradId = 'mg-' + Math.random().toString(36).slice(2, 8);
  let threshHTML = '';
  if (ser.warn != null && ser.warn >= minY && ser.warn <= maxY) {
    const wy = sy(ser.warn).toFixed(1);
    threshHTML += `<line x1="${padL}" y1="${wy}" x2="${w - padR}" y2="${wy}" stroke="var(--warn)" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${w - padR - 2}" y="${(Number(wy) - 3).toFixed(1)}" text-anchor="end" fill="var(--warn-fg)" font-size="9">WARN ${ser.warn}</text>`;
  }
  if (ser.crit != null && ser.crit >= minY && ser.crit <= maxY) {
    const cy = sy(ser.crit).toFixed(1);
    threshHTML += `<line x1="${padL}" y1="${cy}" x2="${w - padR}" y2="${cy}" stroke="var(--crit)" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${w - padR - 2}" y="${(Number(cy) - 3).toFixed(1)}" text-anchor="end" fill="var(--crit-fg)" font-size="9">CRIT ${ser.crit}</text>`;
  }
  const dots = pts.length <= 45 ? pts.map(p => `<circle cx="${sx(p.ts).toFixed(1)}" cy="${sy(p.v).toFixed(1)}" r="2.4" fill="var(--accent)"><title>${new Date(p.ts*1000).toLocaleTimeString()} — ${p.v}${ser.unit||''}</title></circle>`).join('') : '';
  const tStart = new Date(minT * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tEnd = new Date(maxT * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:148px;display:block">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/></linearGradient></defs>
    <line x1="${padL}" y1="${padT}" x2="${w-padR}" y2="${padT}" stroke="var(--border)" stroke-dasharray="3 3"/>
    <line x1="${padL}" y1="${padT + plotH/2}" x2="${w-padR}" y2="${padT + plotH/2}" stroke="var(--border)" stroke-dasharray="3 3"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${w-padR}" y2="${padT + plotH}" stroke="var(--border)"/>
    <text x="${padL-5}" y="${padT+4}" text-anchor="end" fill="var(--muted)" font-size="9.5">${maxY.toFixed(1)}</text>
    <text x="${padL-5}" y="${padT+plotH/2+3}" text-anchor="end" fill="var(--muted)" font-size="9.5">${((maxY+minY)/2).toFixed(1)}</text>
    <text x="${padL-5}" y="${padT+plotH}" text-anchor="end" fill="var(--muted)" font-size="9.5">${minY.toFixed(1)}</text>
    <text x="${padL}" y="${h-5}" fill="var(--muted)" font-size="9.5">${tStart}</text>
    <text x="${w-padR}" y="${h-5}" text-anchor="end" fill="var(--muted)" font-size="9.5">${tEnd}</text>
    <path d="${areaD}" fill="url(#${gradId})"/>
    <path d="${lineD}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${threshHTML}${dots}
  </svg>`;
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

/* Pure SVG Uptime & Incident Trend Bar Chart */
function renderTrendSVG(timeline) {
  if (!timeline || !timeline.length) return '<div class="empty" style="padding:24px">No timeline data</div>';
  const w = 640, h = 132, padL = 32, padB = 22, padT = 12, padR = 8;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const n = timeline.length;
  const step = plotW / n;
  const barW = Math.max(4, Math.min(26, step * 0.68));
  const labelEvery = n > 14 ? Math.ceil(n / 10) : 1;

  const bars = timeline.map((b, i) => {
    const x = padL + i * step + (step - barW) / 2;
    const bh = Math.max(2, (b.ok_pct / 100) * plotH);
    const y = padT + (plotH - bh);
    const col = b.ok_pct >= 99.5 ? 'var(--ok)' : (b.ok_pct >= 95 ? 'var(--warn)' : 'var(--crit)');
    const incDot = b.incidents > 0 ? `<circle cx="${(x + barW/2).toFixed(1)}" cy="${Math.max(padT + 4, y - 5).toFixed(1)}" r="3.5" fill="var(--crit)"/>` : '';
    const lbl = (i % labelEvery === 0 || i === n - 1) ? `<text x="${(x + barW/2).toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="var(--muted)" font-size="9.5">${esc(b.label)}</text>` : '';
    return `<g>
      <title>${esc(b.label)} — SLA: ${b.ok_pct.toFixed(2)}% | HARD Incidents: ${b.incidents}</title>
      <rect x="${x.toFixed(1)}" y="${padT}" width="${barW.toFixed(1)}" height="${plotH}" rx="3" fill="var(--surface-2)"/>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${col}"/>
      ${incDot}${lbl}
    </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:132px;display:block">
    <line x1="${padL}" y1="${padT}" x2="${w-padR}" y2="${padT}" stroke="var(--ok)" stroke-opacity="0.45" stroke-dasharray="4 3"/>
    <line x1="${padL}" y1="${padT + plotH/2}" x2="${w-padR}" y2="${padT + plotH/2}" stroke="var(--border)" stroke-dasharray="3 3"/>
    <text x="${padL-4}" y="${padT+4}" text-anchor="end" fill="var(--ok-fg)" font-size="9">99.9%</text>
    <text x="${padL-4}" y="${padT+plotH/2+3}" text-anchor="end" fill="var(--muted)" font-size="9">50%</text>
    <text x="${padL-4}" y="${padT+plotH}" text-anchor="end" fill="var(--muted)" font-size="9">0%</text>
    ${bars}
  </svg>`;
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
            <div class="table-wrap"><table><thead><tr><th>Service</th><th>Uptime Bar</th><th>OK %</th><th>WARN %</th><th>CRIT %</th><th>Downtime %</th><th>Incidents</th><th>MTTR</th></tr></thead><tbody>
              ${g.list.map(r => `<tr>
                <td><a href="#" style="color:var(--accent);text-decoration:none;font-weight:600" onclick="openReportFor('${esc(r.host)}','${esc(r.service)}');return false">${esc(r.service)}</a></td>
                <td style="min-width:120px"><div class="bar"><div class="bar-ok" style="width:${r.ok_pct}%"></div><div class="bar-warn" style="width:${r.warn_pct}%"></div><div class="bar-crit" style="width:${r.crit_pct}%"></div></div></td>
                <td class="mono" style="color:var(--ok-fg);font-weight:700">${r.ok_pct.toFixed(2)}%</td>
                <td class="mono">${r.warn_pct.toFixed(2)}%</td>
                <td class="mono" style="color:${r.crit_pct>0?'var(--crit-fg)':'var(--muted)'}">${r.crit_pct.toFixed(2)}%</td>
                <td class="mono">${r.downtime_pct.toFixed(2)}%</td>
                <td class="mono">${r.incidents}</td>
                <td class="mono">${r.mttr_sec ? Math.round(r.mttr_sec) + 's' : '-'}</td>
              </tr>`).join('')}
            </tbody></table></div>
          </div>
        </div>`;
      }).join('') : '<div class="empty">No objects in selected scope</div>';
    } else {
      tableHTML = `<div class="table-wrap"><table><thead><tr><th>Host</th>${target==='services'?'<th>Service</th>':''}<th>Uptime Bar</th><th>UP/OK %</th><th>WARN %</th><th>CRIT/DOWN %</th><th>Downtime %</th><th>Incidents</th><th>MTTR</th></tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr>
          <td><b>${esc(r.host)}</b></td>
          ${target==='services'?`<td>${esc(r.service)}</td>`:''}
          <td style="min-width:130px"><div class="bar"><div class="bar-ok" style="width:${r.ok_pct}%"></div><div class="bar-warn" style="width:${r.warn_pct}%"></div><div class="bar-crit" style="width:${r.crit_pct}%"></div></div></td>
          <td class="mono" style="color:var(--ok-fg);font-weight:700">${r.ok_pct.toFixed(2)}%</td>
          <td class="mono">${r.warn_pct.toFixed(2)}%</td>
          <td class="mono" style="color:${r.crit_pct>0?'var(--crit-fg)':'var(--muted)'}">${r.crit_pct.toFixed(2)}%</td>
          <td class="mono">${r.downtime_pct.toFixed(2)}%</td>
          <td class="mono">${r.incidents}</td>
          <td class="mono">${r.mttr_sec ? Math.round(r.mttr_sec) + 's' : '-'}</td>
        </tr>`).join('') : '<tr><td colspan="9" class="empty">No objects in selected scope</td></tr>'}
      </tbody></table></div>`;
    }

    const scopeTag = [hg, host, service].filter(Boolean).join(' / ') || 'All Scope';
    el.innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">Overall SLA</span><img class="kpi-icon" src="/assets/status/${sum.overall_sla_pct >= 99 ? 'status-ok.svg' : 'status-warn.svg'}"></div><div class="kpi-val">${(sum.overall_sla_pct ?? 100).toFixed(2)}%</div><div class="kpi-sub"><span>${sum.total_objects || 0} ${esc(target)} • ${esc(scopeTag)}</span></div></div>
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">HARD Incidents</span><img class="kpi-icon" src="/assets/icons/alert.svg"></div><div class="kpi-val">${sum.total_incidents || 0}</div><div class="kpi-sub"><span>Window: ${S.repRange}</span></div></div>
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">Avg Recovery (MTTR)</span><img class="kpi-icon" src="/assets/icons/bell.svg"></div><div class="kpi-val">${sum.avg_mttr_sec ? Math.round(sum.avg_mttr_sec) + 's' : '0s'}</div><div class="kpi-sub"><span>Mean Time To Recovery</span></div></div>
      </div>
      <div class="charts-row">
        <div class="chart-card">
          <div class="chart-title"><span>State Breakdown</span></div>
          ${renderDonutSVG(sum)}
        </div>
        <div class="chart-card">
          <div class="chart-title"><span>Uptime &amp; Incident Trend</span><span class="name-sub">Red dot = HARD incident</span></div>
          ${renderTrendSVG(timeline)}
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
        <span class="name-sub">${series.length} metric series recorded from Nagios perf_data</span>
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
        <div class="panel-head"><div class="panel-title">Nagios Event Log (${data.total || 0} entries)</div></div>
        <div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Target</th><th>Message</th></tr></thead><tbody>
          ${evs.length ? evs.map(e => `<tr>
            <td class="mono" style="white-space:nowrap">${new Date(e.timestamp*1000).toLocaleString()}</td>
            <td><span class="flag-tag">${esc(e.type)}</span></td>
            <td class="mono">${esc(e.host || '-')} ${e.service ? '/ ' + esc(e.service) : ''}</td>
            <td class="mono" style="color:var(--text)">${esc(e.message)}</td>
          </tr>`).join('') : '<tr><td colspan="4" class="empty">No log entries found (check -nagios-log path).</td></tr>'}
        </tbody></table></div>
      </div>`;
  }
}
