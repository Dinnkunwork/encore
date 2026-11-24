S.repTab = 'sla';
S.repRange = '24h';

function setReportTab(t) {
  S.repTab = t;
  ['sla','alerts','eventlog'].forEach(k => document.getElementById('rtab-' + k)?.classList.toggle('active', k === t));
  loadReports();
}

function setReportRange(r) {
  S.repRange = r;
  ['24h','7d','30d'].forEach(k => document.getElementById('rr-' + k)?.classList.toggle('active', k === r));
  loadReports();
}

function getReportBounds() {
  const now = Math.floor(Date.now() / 1000);
  const map = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
  return { from: now - (map[S.repRange] || 86400), to: now };
}

function exportReport(fmt) {
  const { from, to } = getReportBounds();
  const target = document.getElementById('rep-target')?.value || 'services';
  const hg = document.getElementById('rep-hg')?.value || '';
  const qs = new URLSearchParams({ from, to, target, format: fmt });
  if (hg) qs.set('hostgroup', hg);
  const url = '/api/v1/reports/export?' + qs.toString();
  if (fmt === 'html') window.open(url, '_blank');
  else window.location.href = url;
}

async function loadReports() {
  const el = document.getElementById('reports-content');
  const { from, to } = getReportBounds();
  const target = document.getElementById('rep-target')?.value || 'services';
  const hg = document.getElementById('rep-hg')?.value || '';

  // Sync hostgroup dropdown
  const hgSel = document.getElementById('rep-hg');
  if (hgSel && hgSel.options.length <= 1 && S.hostgroups.length) {
    hgSel.innerHTML = '<option value="">All Hostgroups</option>' + S.hostgroups.map(g => `<option value="${esc(g.group_name)}">${esc(g.group_name)}</option>`).join('');
  }

  document.getElementById('rep-sla-controls').style.display = S.repTab === 'sla' ? 'flex' : 'none';

  if (S.repTab === 'sla') {
    const qs = new URLSearchParams({ from, to, target });
    if (hg) qs.set('hostgroup', hg);
    const data = await (await fetch('/api/v1/reports/availability?' + qs)).json();
    const sum = data.summary || {};
    const rows = data.rows || [];

    el.innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">Overall SLA</span><img class="kpi-icon" src="/assets/status/${sum.overall_sla_pct >= 99 ? 'status-ok.svg' : 'status-warn.svg'}"></div><div class="kpi-val">${(sum.overall_sla_pct ?? 100).toFixed(2)}%</div><div class="kpi-sub"><span>${sum.total_objects || 0} ${esc(target)}</span></div></div>
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">HARD Incidents</span><img class="kpi-icon" src="/assets/icons/alert.svg"></div><div class="kpi-val">${sum.total_incidents || 0}</div><div class="kpi-sub"><span>Window: ${S.repRange}</span></div></div>
        <div class="kpi-card" style="cursor:default"><div class="kpi-top"><span class="kpi-label">Avg Recovery (MTTR)</span><img class="kpi-icon" src="/assets/icons/bell.svg"></div><div class="kpi-val">${sum.avg_mttr_sec ? Math.round(sum.avg_mttr_sec) + 's' : '0s'}</div><div class="kpi-sub"><span>Mean Time To Recovery</span></div></div>
      </div>
      <div class="panel">
        <div class="table-wrap"><table><thead><tr><th>Host</th>${target==='services'?'<th>Service</th>':''}<th>Uptime Bar</th><th>UP/OK %</th><th>WARN %</th><th>CRIT/DOWN %</th><th>Downtime %</th><th>Incidents</th><th>MTTR</th></tr></thead><tbody>
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
        </tbody></table></div>
      </div>`;
  } else if (S.repTab === 'alerts') {
    const hardOnly = document.getElementById('rep-hard-only')?.checked ? '1' : '0';
    const qs = new URLSearchParams({ from, to, type: 'alerts', hard_only: hardOnly, limit: 150 });
    const data = await (await fetch('/api/v1/reports/events?' + qs)).json();
    const evs = data.events || [];
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Alert & Notification History (${data.total || 0})</div>
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
