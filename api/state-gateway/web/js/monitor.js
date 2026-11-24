async function loadMeta() {
  const [hRes, sRes, hgRes, sgRes] = await Promise.all([
    fetch('/health'), fetch('/api/v1/summary'), fetch('/api/v1/hostgroups'), fetch('/api/v1/servicegroups')
  ]);
  const health = await hRes.json();
  const sum = await sRes.json();
  S.summary = sum;
  S.hostgroups = (await hgRes.json()).hostgroups || [];
  S.servicegroups = (await sgRes.json()).servicegroups || [];

  document.getElementById('conn-icon').src = health.connected ? '/assets/status/status-ok.svg' : '/assets/status/status-critical.svg';
  document.getElementById('conn-label').textContent = health.connected ? 'Live' : 'Reconnecting';
  document.getElementById('events-pill').textContent = (health.events_applied || 0).toLocaleString() + ' ev';
  document.getElementById('sb-apply-btn').style.display = health.pending_changes ? 'block' : 'none';
  const pbBanner = document.getElementById('pending-banner');
  if (pbBanner) pbBanner.style.display = health.pending_changes ? 'flex' : 'none';
  document.getElementById('sub-meta').textContent = `PID ${sum.program.pid} • ${sum.hosts.total} hosts, ${sum.services.total} services • ${new Date().toLocaleTimeString()}`;

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

/* Isolated filter state per view (fixes Problems -> Inventory state=2 leak) */
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

  const [pRes, aRes] = await Promise.all([
    fetch('/api/v1/services?unhandled=1&sort=severity&limit=10'),
    fetch('/api/v1/audit?limit=5')
  ]);
  const probs = (await pRes.json()).services || [];
  const pBody = document.getElementById('ov-prob-body');
  if (!probs.length) {
    pBody.innerHTML = '<tr><td colspan="5" class="empty"><img src="/assets/status/status-ok.svg" style="width:16px;vertical-align:middle;margin-right:6px">No unhandled problems.</td></tr>';
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

function setInvTab(t) {
  S.invTab = t;
  S.invFilter.state = '';
  S.offset = 0;
  S.selectedMon.clear();
  populateStateSelect(t, '');
  renderMonitorSubtabs();
  loadMonitorView();
}
function setProbTab(t) {
  S.probTab = t;
  S.offset = 0;
  S.selectedMon.clear();
  renderMonitorSubtabs();
  loadMonitorView();
}
function quickUnhandled() {
  S.probFilter.unhandled = true;
  S.probFilter.state = '';
  setView('problems', 'active');
}
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
function onFilterChange() {
  saveMonitorFilterState(S.view);
  S.offset = 0;
  S.selectedMon.clear();
  loadMonitorView();
}
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

/* Bulk Selection for Monitor */
function monItemKey(mode, item) {
  return mode === 'hosts' ? ('host::' + item.name) : ('svc::' + item.host_name + '::' + item.description);
}
function toggleMonSelect(key, checked) {
  if (checked) S.selectedMon.add(key); else S.selectedMon.delete(key);
  renderBulkBar();
}
function toggleMonSelectAll(checked) {
  const mode = S.view === 'problems' ? 'problems' : S.invTab;
  S.selectedMon.clear();
  if (checked) {
    S.lastItems.forEach(it => S.selectedMon.add(monItemKey(mode, it)));
  }
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
      <button class="btn btn-sm" onclick="bulkMonitorAck()">✓ Acknowledge All</button>
      <button class="btn btn-sm" onclick="bulkMonitorDowntime()">⏱ Schedule Downtime</button>
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
function bulkMonitorAck() {
  const cmt = prompt('Acknowledge comment for ' + S.selectedMon.size + ' item(s):', 'Bulk acknowledged via Encore');
  if (!cmt) return;
  const cmds = [];
  S.selectedMon.forEach(k => {
    const p = k.split('::');
    if (p[0] === 'host') cmds.push(`ACKNOWLEDGE_HOST_PROBLEM;${p[1]};2;0;1;encore-ui;${cmt}`);
    else cmds.push(`ACKNOWLEDGE_SVC_PROBLEM;${p[1]};${p[2]};2;0;1;encore-ui;${cmt}`);
  });
  sendBatchCmds(cmds, 'Bulk acknowledge');
}
function bulkMonitorDowntime() {
  const minsStr = prompt('Downtime duration (minutes) for ' + S.selectedMon.size + ' item(s):', '60');
  const mins = Math.max(1, Number(minsStr) || 0);
  if (!minsStr || !mins) return;
  const now = Math.floor(Date.now()/1000);
  const cmds = [];
  S.selectedMon.forEach(k => {
    const p = k.split('::');
    if (p[0] === 'host') cmds.push(`SCHEDULE_HOST_DOWNTIME;${p[1]};${now};${now+mins*60};1;0;0;encore-ui;Bulk maintenance`);
    else cmds.push(`SCHEDULE_SVC_DOWNTIME;${p[1]};${p[2]};${now};${now+mins*60};1;0;0;encore-ui;Bulk maintenance`);
  });
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
      rowsHTML = '<tr><td colspan="7" class="empty">No matching services</td></tr>';
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
  const dts = (await (await fetch('/api/v1/downtimes')).json()).downtimes || [];
  const rows = dts.length ? dts.map(d => {
    const delCmd = d.type === 1 ? `DEL_SVC_DOWNTIME;${d.downtime_id}` : `DEL_HOST_DOWNTIME;${d.downtime_id}`;
    return `<tr>
      <td class="mono">#${d.downtime_id}</td>
      <td><div class="name-primary">${esc(d.host_name)}</div>${d.service_description ? `<div class="name-sub">${esc(d.service_description)}</div>` : ''}</td>
      <td class="mono">${new Date(d.start_time*1000).toLocaleString()} → ${new Date(d.end_time*1000).toLocaleString()}</td>
      <td>${d.is_in_effect ? '<span class="badge c-warn">ACTIVE</span>' : '<span class="badge c-pend">SCHEDULED</span>'}</td>
      <td><b>${esc(d.author)}</b>: ${esc(d.comment)}</td>
      <td class="actions"><button class="btn btn-sm danger" onclick="sendCmd('${delCmd}','Cancel downtime #${d.downtime_id}')">Cancel</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">No active or scheduled downtimes</td></tr>';

  document.getElementById('mon-body').innerHTML = `<div class="panel"><div class="table-wrap"><table><thead><tr><th>ID</th><th>Target</th><th>Window</th><th>Status</th><th>Comment</th><th style="text-align:right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
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
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:14px">
      <button class="btn btn-sm primary" onclick="sendCmd('SCHEDULE_FORCED_SVC_CHECK;${esc(s.host_name)};${esc(s.description)};'+Math.floor(Date.now()/1000),'Force check')">↻ Force Check</button>
      ${s.current_state>0 && !s.acknowledged ? `<button class="btn btn-sm" onclick="closeDrawer();openAckModal('service','${esc(s.host_name)}','${esc(s.description)}')">✓ Acknowledge</button>` : ''}
      ${s.acknowledged ? `<button class="btn btn-sm" onclick="sendCmd('REMOVE_SVC_ACKNOWLEDGEMENT;${esc(s.host_name)};${esc(s.description)}','Remove ACK')">Remove ACK</button>` : ''}
      <button class="btn btn-sm" onclick="closeDrawer();openDowntimeModal('service','${esc(s.host_name)}','${esc(s.description)}')">⏱ Downtime</button>
      <button class="btn btn-sm" onclick="sendCmd('DISABLE_SVC_CHECK;${esc(s.host_name)};${esc(s.description)}','Disable check')">Disable</button>
      <button class="btn btn-sm" onclick="sendCmd('ENABLE_SVC_CHECK;${esc(s.host_name)};${esc(s.description)}','Enable check')">Enable</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <button class="btn btn-sm" onclick="closeDrawer();openReportFor('${esc(s.host_name)}','${esc(s.description)}')">View SLA Report ›</button>
      <button class="btn btn-sm" onclick="closeDrawer();jumpToManageHost('${esc(s.host_name)}')">Edit Config ›</button>
    </div>`;
  document.getElementById('drawer-wrap').classList.add('open');
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
