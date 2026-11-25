function setManageTab(mt) {
  S.manageTab = mt;
  ['objects','templates','commands','groups','notifications','secrets'].forEach(t => {
    const el = document.getElementById('mtab-' + t);
    if (el) el.classList.toggle('active', t === mt);
  });
  loadManage();
}

function jumpToManageHost(hostName) {
  S.manageSearch = hostName;
  S.expandedHosts.add(hostName);
  setView('manage', 'objects');
}
async function jumpAddServiceForHost(hostName) {
  setView('manage', 'objects');
  await loadManage();
  openSvcForm(-1, hostName);
}

async function ensureCatalogCommands() {
  if (!S.catalogCmds || !S.catalogCmds.length) {
    try {
      const r = await fetch('/api/v1/catalog/commands');
      S.catalogCmds = (await r.json()).commands || [];
    } catch (e) {}
  }
}

/* Build O(1) lookup maps for diff highlighting */
function getDiffMaps() {
  const diff = (S.managed && S.managed.diff) || { entries: [] };
  const m = { host: new Map(), service: new Map(), command: new Map(), contact: new Map(), hostgroup: new Map(), servicegroup: new Map() };
  (diff.entries || []).forEach(e => {
    if (m[e.kind]) m[e.kind].set(e.id, e);
  });
  return m;
}
function diffBadge(entry) {
  if (!entry) return '';
  if (entry.status === 'added') return ' <span class="badge c-ok" title="New draft — not applied yet">NEW</span>';
  if (entry.status === 'modified') {
    const tip = entry.changes && entry.changes.length ? 'Changed: ' + entry.changes.join(', ') : 'Modified draft';
    return ` <span class="badge c-warn" title="${esc(tip)}">MODIFIED</span>`;
  }
  return '';
}
function diffRowClass(entry) {
  if (!entry) return '';
  return entry.status === 'added' ? 'diff-added' : (entry.status === 'modified' ? 'diff-modified' : '');
}

async function openDiffReviewModal() {
  const diff = await (await fetch('/api/v1/config/diff')).json();
  S.managed.diff = diff;
  const entries = diff.entries || [];
  openModal(`
    <h2>Pending Configuration Changes (${diff.total || 0})</h2>
    <p class="name-sub" style="margin-bottom:12px">Perubahan di bawah masih berstatus <b>Draft</b> dan belum aktif di Nagios Core sampai Anda klik <b>Apply &amp; Reload</b>.</p>
    ${entries.length ? `<div class="table-wrap" style="max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:8px"><table>
      <thead><tr><th>Status</th><th>Type</th><th>Object</th><th>Changed Fields</th></tr></thead><tbody>
      ${entries.map(e => {
        const cls = e.status === 'added' ? 'c-ok' : (e.status === 'modified' ? 'c-warn' : 'c-crit');
        return `<tr>
          <td><span class="badge ${cls}">${esc(e.status.toUpperCase())}</span></td>
          <td><span class="flag-tag">${esc(e.kind)}</span></td>
          <td><b>${esc(e.label)}</b></td>
          <td class="mono">${esc((e.changes||[]).join(', ') || '-')}</td>
        </tr>`;
      }).join('')}
      </tbody></table></div>` : '<div class="empty" style="padding:18px">No pending changes — live config is in sync.</div>'}
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Close</button>
      ${entries.length ? `<button class="btn danger" onclick="closeModal();discardPendingChanges()">Discard All</button>
      <button class="btn primary" onclick="closeModal();runValidate(true)">Apply &amp; Reload</button>` : ''}
    </div>`);
}

async function discardPendingChanges() {
  const diff = await (await fetch('/api/v1/config/diff')).json();
  const items = (diff.entries || []).map(e => `${e.status.toUpperCase()}: ${e.kind} ${e.label}`);
  const ok = await encoreConfirm({
    title: 'Discard Pending Config Changes?',
    message: 'Seluruh perubahan draft (Hosts, Services, Commands, Groups, Contacts) yang belum di-Apply akan dibatalkan dan dikembalikan ke konfigurasi live terakhir. Templates & Notifications tidak terpengaruh.',
    items,
    confirmText: `Discard ${diff.total || ''} Change(s)`,
    danger: true
  });
  if (!ok) return;
  const res = await fetch('/api/v1/config/discard', { method: 'POST' });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  S.selectedManagedHosts.clear();
  S.selectedManagedSvcs.clear();
  toast(`Discarded ${d.reverted} pending change(s)`);
  if (S.view === 'manage') await loadManage();
  await loadMeta();
}

async function loadManage() {
  const [cfgRes, lhRes] = await Promise.all([
    fetch('/api/v1/config'),
    fetch('/api/v1/config/localhost').catch(() => null)
  ]);
  S.managed = await cfgRes.json();
  if (lhRes && lhRes.ok) S.localhostStatus = await lhRes.json();
  const el = document.getElementById('manage-content');
  const c = S.managed.config;

  if (S.manageTab === 'secrets') { await renderSecretsTab(el); return; }
  if (S.manageTab === 'notifications') { await renderNotificationsTab(el); return; }
  if (!S.managed.enabled) {
    el.innerHTML = `<div class="panel"><div class="empty">Config management disabled. Start gateway with <code class="code-chip">-managed-dir /usr/local/nagios/etc/encore.d</code>.</div></div>`;
    return;
  }

  if (S.manageTab === 'objects') renderManageObjects(el, c);
  else if (S.manageTab === 'templates') renderTemplatesTab(el, c);
  else if (S.manageTab === 'commands') await renderCommandsTab(el, c);
  else if (S.manageTab === 'groups') renderGroupsManageTab(el, c);
}

/* ====== OBJECTS TAB: Search + Accordion + Diff Highlight + Bulk Host & Service Delete ====== */
function renderManageObjects(el, c) {
  const lh = S.localhostStatus;
  const showAdoptBanner = lh && lh.configured && lh.exists && !lh.adopted && ((lh.parsed_hosts||[]).length || (lh.parsed_services||[]).length);

  const hgSet = new Set();
  c.hosts.forEach(h => (h.hostgroups || []).forEach(g => hgSet.add(g)));
  (c.hostgroups || []).forEach(g => hgSet.add(g.group_name));
  const hgOpts = [...hgSet].sort();

  const gf = S.manageGroup || '';
  const sf = S.manageStatus || '';

  el.innerHTML = `
    ${showAdoptBanner ? `<div class="callout-banner">
      <div><b>Standalone <code class="code-chip">localhost.cfg</code> terdeteksi</b> (${(lh.parsed_hosts||[]).length} host, ${(lh.parsed_services||[]).length} services). Adopt agar bisa dikelola penuh di sini.</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm primary" onclick="adoptLocalhost()">1-Click Adopt</button>
        <button class="btn btn-sm" onclick="openLocalhostRawModal()">View Raw</button>
      </div>
    </div>` : ''}
    <div id="mg-bulk-wrap"></div>
    <div class="panel">
      <div class="toolbar-row">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="search" id="mg-search" value="${esc(S.manageSearch)}" placeholder="Search host, IP, service, command..." style="width:240px" oninput="S.manageSearch=this.value;renderManageObjectsBody()">
          <select onchange="S.manageGroup=this.value;renderManageObjectsBody()">
            <option value="">All Hostgroups</option>
            ${hgOpts.map(g => `<option value="${esc(g)}" ${gf===g?'selected':''}>${esc(g)}</option>`).join('')}
          </select>
          <select onchange="S.manageStatus=this.value;renderManageObjectsBody()">
            <option value="">All Status</option>
            <option value="on" ${sf==='on'?'selected':''}>Enabled (ON)</option>
            <option value="off" ${sf==='off'?'selected':''}>Disabled (OFF)</option>
          </select>
          <button class="btn btn-sm ${!S.manageFlat?'active':''}" id="mg-mode-grp" onclick="S.manageFlat=false;updateManageModeBtns();renderManageObjectsBody()">Grouped</button>
          <button class="btn btn-sm ${S.manageFlat?'active':''}" id="mg-mode-flat" onclick="S.manageFlat=true;updateManageModeBtns();renderManageObjectsBody()">Flat</button>
          <button class="btn btn-sm" id="mg-exp-btn" style="${S.manageFlat?'display:none':''}" onclick="toggleExpandAllManaged()">${S.expandedHosts.size ? 'Collapse All' : 'Expand All'}</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span class="save-scope-pill draft">Draft • Apply &amp; Reload</span>
          <button class="btn btn-sm" onclick="openSvcForm(-1)">+ Add Service</button>
          <button class="btn btn-sm primary" onclick="openHostForm(-1)">+ Add Host</button>
        </div>
      </div>
      <div id="mg-objects-body"></div>
    </div>
    <div id="mg-orphan-wrap"></div>`;
  renderManageObjectsBody();
}

function updateManageModeBtns() {
  document.getElementById('mg-mode-grp')?.classList.toggle('active', !S.manageFlat);
  document.getElementById('mg-mode-flat')?.classList.toggle('active', S.manageFlat);
  const exp = document.getElementById('mg-exp-btn');
  if (exp) {
    exp.style.display = S.manageFlat ? 'none' : '';
    exp.textContent = S.expandedHosts.size ? 'Collapse All' : 'Expand All';
  }
}

function svcRefKey(host, desc) { return host + '::' + desc; }
function toggleSelectManagedSvc(host, desc, checked) {
  const k = svcRefKey(host, desc);
  if (checked) S.selectedManagedSvcs.add(k); else S.selectedManagedSvcs.delete(k);
  renderManageObjectsBody();
}
function toggleSelectAllHostSvcs(host, checked) {
  (S.managed.config.services || []).filter(s => s.host_name === host).forEach(s => {
    const k = svcRefKey(s.host_name, s.service_description);
    if (checked) S.selectedManagedSvcs.add(k); else S.selectedManagedSvcs.delete(k);
  });
  renderManageObjectsBody();
}

function renderManageObjectsBody() {
  const c = S.managed.config;
  const dm = getDiffMaps();
  const q = (S.manageSearch || '').toLowerCase().trim();
  const gf = S.manageGroup || '';
  const sf = S.manageStatus || '';

  const svcsByHost = new Map();
  c.services.forEach((s, idx) => {
    if (!svcsByHost.has(s.host_name)) svcsByHost.set(s.host_name, []);
    svcsByHost.get(s.host_name).push({ s, idx });
  });

  const filteredHosts = [];
  c.hosts.forEach((h, idx) => {
    if (gf && !(h.hostgroups || []).includes(gf)) return;
    if (sf === 'on' && !h.enabled) return;
    if (sf === 'off' && h.enabled) return;
    const hostSvcs = svcsByHost.get(h.name) || [];
    const hostMatch = !q ||
      h.name.toLowerCase().includes(q) ||
      (h.alias || '').toLowerCase().includes(q) ||
      (h.address || '').toLowerCase().includes(q) ||
      (h.check_command || '').toLowerCase().includes(q);
    const matchingSvcs = q ? hostSvcs.filter(({ s }) =>
      s.service_description.toLowerCase().includes(q) ||
      s.check_command.toLowerCase().includes(q) ||
      (s.servicegroups || []).some(g => g.toLowerCase().includes(q))
    ) : hostSvcs;
    if (hostMatch || matchingSvcs.length > 0) {
      filteredHosts.push({ h, idx, svcs: hostMatch ? hostSvcs : matchingSvcs });
    }
  });

  const hostNameSet = new Set(c.hosts.map(h => h.name));
  const orphanSvcs = [];
  c.services.forEach((s, idx) => {
    if (!hostNameSet.has(s.host_name)) {
      if (!q || s.host_name.toLowerCase().includes(q) || s.service_description.toLowerCase().includes(q) || s.check_command.toLowerCase().includes(q)) {
        orphanSvcs.push({ s, idx });
      }
    }
  });

  const bulkWrap = document.getElementById('mg-bulk-wrap');
  if (bulkWrap) {
    const hCnt = S.selectedManagedHosts.size;
    const sCnt = S.selectedManagedSvcs.size;
    let html = '';
    if (hCnt > 0) {
      html += `<div class="bulk-bar">
        <div><b>${hCnt}</b> host(s) selected</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm primary" onclick="openApplyTemplateModal([...S.selectedManagedHosts])">Apply Template</button>
          <button class="btn btn-sm" onclick="bulkManagedHosts('enable')">Enable</button>
          <button class="btn btn-sm" onclick="bulkManagedHosts('disable')">Disable</button>
          <button class="btn btn-sm danger" onclick="bulkManagedHosts('delete')">Delete ${hCnt} Host(s)</button>
          <button class="btn btn-sm" onclick="S.selectedManagedHosts.clear();renderManageObjectsBody()">Clear</button>
        </div>
      </div>`;
    }
    if (sCnt > 0) {
      html += `<div class="bulk-bar">
        <div><b>${sCnt}</b> service(s) selected</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="bulkManagedSvcs('enable')">Enable</button>
          <button class="btn btn-sm" onclick="bulkManagedSvcs('disable')">Disable</button>
          <button class="btn btn-sm danger" onclick="bulkManagedSvcs('delete')">Delete ${sCnt} Service(s)</button>
          <button class="btn btn-sm" onclick="S.selectedManagedSvcs.clear();renderManageObjectsBody()">Clear</button>
        </div>
      </div>`;
    }
    bulkWrap.innerHTML = html;
  }

  let bodyHTML = '';
  if (!S.manageFlat) {
    bodyHTML = filteredHosts.length ? filteredHosts.map(({ h, idx, svcs }) => {
      const hDiff = dm.host.get(h.name);
      const hasSvcDiff = svcs.some(({ s }) => dm.service.has(svcRefKey(s.host_name, s.service_description)));
      const open = S.expandedHosts.has(h.name) || (q.length > 0 && svcs.length > 0) || hasSvcDiff;
      const checked = S.selectedManagedHosts.has(h.name);
      const allSvcsChecked = svcs.length > 0 && svcs.every(({ s }) => S.selectedManagedSvcs.has(svcRefKey(s.host_name, s.service_description)));
      return `<div class="host-acc ${open?'open':''} ${diffRowClass(hDiff)}">
        <div class="host-acc-head" onclick="toggleManageHostAcc('${esc(h.name)}')">
          <div class="host-acc-left">
            <input type="checkbox" ${checked?'checked':''} onclick="event.stopPropagation()" onchange="toggleSelectManagedHost('${esc(h.name)}',this.checked)">
            <span class="host-acc-chev">▶</span>
            <div>
              <span class="name-primary">${esc(h.name)}</span>${diffBadge(hDiff)}
              <span class="mono" style="margin-left:8px">${esc(h.address)}</span>
              ${h.alias && h.alias !== h.name ? `<span class="name-sub" style="margin-left:6px">(${esc(h.alias)})</span>` : ''}
            </div>
            <span class="flag-tag">${svcs.length} svc</span>
            ${(h.hostgroups||[]).map(g => `<span class="flag-tag">${esc(g)}</span>`).join('')}
            ${h.enabled ? '<span class="badge c-ok">ON</span>' : '<span class="badge c-pend">OFF</span>'}
          </div>
          <div class="actions" onclick="event.stopPropagation()">
            <button class="btn btn-sm" onclick="openSvcForm(-1,'${esc(h.name)}')">+ Svc</button>
            <button class="btn btn-sm" onclick="openApplyTemplateModal(['${esc(h.name)}'])">Template</button>
            <button class="btn btn-sm" onclick="openHostForm(${idx})">Edit</button>
            <button class="btn btn-sm" onclick="openCloneHostModal('${esc(h.name)}')">Clone</button>
            <button class="btn btn-sm danger" onclick="deleteManagedHost('${esc(h.name)}')">Delete</button>
          </div>
        </div>
        <div class="host-acc-body">
          ${svcs.length ? `<div class="table-wrap"><table><thead><tr>
            <th style="width:30px"><input type="checkbox" ${allSvcsChecked?'checked':''} onchange="toggleSelectAllHostSvcs('${esc(h.name)}',this.checked)" title="Select all services of ${esc(h.name)}"></th>
            <th>Service</th><th>Check Command</th><th>Groups</th><th>Interval</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>
            ${svcs.map(({ s, idx: si }) => {
              const sk = svcRefKey(s.host_name, s.service_description);
              const sd = dm.service.get(sk);
              return `<tr class="${diffRowClass(sd)}">
                <td><input type="checkbox" ${S.selectedManagedSvcs.has(sk)?'checked':''} onchange="toggleSelectManagedSvc('${esc(s.host_name)}','${esc(s.service_description)}',this.checked)"></td>
                <td><b>${esc(s.service_description)}</b>${diffBadge(sd)}</td>
                <td class="mono">${esc(s.check_command)}</td>
                <td class="mono">${esc((s.servicegroups||[]).join(', ')||'-')}</td>
                <td class="mono">${s.check_interval||5}m</td>
                <td>${s.enabled?'<span class="badge c-ok">ON</span>':'<span class="badge c-pend">OFF</span>'}</td>
                <td class="actions">
                  <button class="btn btn-sm" onclick="openSvcForm(${si})">Edit</button>
                  <button class="btn btn-sm" onclick="openCloneSvcModal('${esc(s.host_name)}','${esc(s.service_description)}')">Clone</button>
                  <button class="btn btn-sm danger" onclick="deleteManagedSvc('${esc(s.host_name)}','${esc(s.service_description)}')">Delete</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody></table></div>` : `<div class="empty" style="padding:14px">No services yet — <button class="btn btn-sm" onclick="openSvcForm(-1,'${esc(h.name)}')">+ Add Service</button> or <button class="btn btn-sm" onclick="openApplyTemplateModal(['${esc(h.name)}'])">Apply Template</button></div>`}
        </div>
      </div>`;
    }).join('') : `<div class="art-empty">${artSVG('servers')}<h4>No Matching Hosts</h4><p>Tambahkan host baru atau ubah kata kunci pencarian Anda.</p></div>`;
  } else {
    const flatSvcs = [];
    filteredHosts.forEach(({ svcs }) => svcs.forEach(x => flatSvcs.push(x)));
    bodyHTML = `
      <div class="table-wrap"><table><thead><tr><th style="width:32px"></th><th>Host</th><th>Address</th><th>Command</th><th>Groups</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${filteredHosts.length ? filteredHosts.map(({ h, idx }) => {
          const hd = dm.host.get(h.name);
          return `<tr class="${diffRowClass(hd)}">
            <td><input type="checkbox" ${S.selectedManagedHosts.has(h.name)?'checked':''} onchange="toggleSelectManagedHost('${esc(h.name)}',this.checked)"></td>
            <td><b>${esc(h.name)}</b>${diffBadge(hd)}<div class="name-sub">${esc(h.alias)}</div></td>
            <td class="mono">${esc(h.address)}</td><td class="mono">${esc(h.check_command)}</td>
            <td class="mono">${esc((h.hostgroups||[]).join(', ')||'-')}</td>
            <td>${h.enabled?'<span class="badge c-ok">ON</span>':'<span class="badge c-pend">OFF</span>'}</td>
            <td class="actions">
              <button class="btn btn-sm" onclick="openHostForm(${idx})">Edit</button>
              <button class="btn btn-sm" onclick="openCloneHostModal('${esc(h.name)}')">Clone</button>
              <button class="btn btn-sm danger" onclick="deleteManagedHost('${esc(h.name)}')">Delete</button>
            </td></tr>`;
        }).join('') : '<tr><td colspan="7" class="empty">No matching hosts.</td></tr>'}
      </tbody></table></div>
      <div class="panel-head" style="border-top:1px solid var(--border)"><div class="panel-title">Services (${flatSvcs.length})</div></div>
      <div class="table-wrap"><table><thead><tr><th style="width:32px"></th><th>Host</th><th>Service</th><th>Command</th><th>Groups</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${flatSvcs.length ? flatSvcs.map(({ s, idx }) => {
          const sk = svcRefKey(s.host_name, s.service_description);
          const sd = dm.service.get(sk);
          return `<tr class="${diffRowClass(sd)}">
            <td><input type="checkbox" ${S.selectedManagedSvcs.has(sk)?'checked':''} onchange="toggleSelectManagedSvc('${esc(s.host_name)}','${esc(s.service_description)}',this.checked)"></td>
            <td><b>${esc(s.host_name)}</b></td><td>${esc(s.service_description)}${diffBadge(sd)}</td>
            <td class="mono">${esc(s.check_command)}</td><td class="mono">${esc((s.servicegroups||[]).join(', ')||'-')}</td>
            <td>${s.enabled?'<span class="badge c-ok">ON</span>':'<span class="badge c-pend">OFF</span>'}</td>
            <td class="actions">
              <button class="btn btn-sm" onclick="openSvcForm(${idx})">Edit</button>
              <button class="btn btn-sm" onclick="openCloneSvcModal('${esc(s.host_name)}','${esc(s.service_description)}')">Clone</button>
              <button class="btn btn-sm danger" onclick="deleteManagedSvc('${esc(s.host_name)}','${esc(s.service_description)}')">Delete</button>
            </td></tr>`;
        }).join('') : '<tr><td colspan="7" class="empty">No matching services.</td></tr>'}
      </tbody></table></div>`;
  }

  const bodyEl = document.getElementById('mg-objects-body');
  if (bodyEl) bodyEl.innerHTML = bodyHTML;

  const orphEl = document.getElementById('mg-orphan-wrap');
  if (orphEl) {
    orphEl.innerHTML = orphanSvcs.length ? `
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Services on External / Unmanaged Hosts (${orphanSvcs.length})</div></div>
        <div class="table-wrap"><table><thead><tr><th>Host</th><th>Service</th><th>Command</th><th style="text-align:right">Actions</th></tr></thead><tbody>
          ${orphanSvcs.map(({ s, idx }) => `<tr><td><b>${esc(s.host_name)}</b></td><td>${esc(s.service_description)}</td><td class="mono">${esc(s.check_command)}</td>
            <td class="actions"><button class="btn btn-sm" onclick="openSvcForm(${idx})">Edit</button><button class="btn btn-sm danger" onclick="deleteManagedSvc('${esc(s.host_name)}','${esc(s.service_description)}')">Delete</button></td></tr>`).join('')}
        </tbody></table></div>
      </div>` : '';
  }
  updateManageModeBtns();
}

function toggleManageHostAcc(name) { if (S.expandedHosts.has(name)) S.expandedHosts.delete(name); else S.expandedHosts.add(name); renderManageObjectsBody(); }
function toggleExpandAllManaged() {
  if (S.expandedHosts.size > 0) S.expandedHosts.clear();
  else (S.managed.config.hosts || []).forEach(h => S.expandedHosts.add(h.name));
  renderManageObjectsBody();
}
function toggleSelectManagedHost(name, checked) { if (checked) S.selectedManagedHosts.add(name); else S.selectedManagedHosts.delete(name); renderManageObjectsBody(); }

async function bulkManagedHosts(action) {
  const hosts = [...S.selectedManagedHosts];
  if (action === 'delete') {
    const ok = await encoreConfirm({
      title: `Delete ${hosts.length} Host(s)?`,
      message: 'Host terpilih beserta seluruh service miliknya akan dihapus dari draft konfigurasi. Anda tetap bisa Discard sebelum Apply & Reload.',
      items: hosts,
      confirmText: `Delete ${hosts.length} Host(s)`,
      danger: true
    });
    if (!ok) return;
  }
  const res = await fetch('/api/v1/config/hosts/bulk', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action, hosts })
  });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  S.selectedManagedHosts.clear();
  toast(`Bulk ${action}: ${d.affected} host(s) staged — click Apply & Reload`);
  await loadManage(); await loadMeta();
}

async function bulkManagedSvcs(action) {
  const refs = [...S.selectedManagedSvcs].map(k => {
    const i = k.indexOf('::');
    return { host_name: k.slice(0, i), service_description: k.slice(i + 2) };
  });
  if (action === 'delete') {
    const ok = await encoreConfirm({
      title: `Delete ${refs.length} Service(s)?`,
      message: 'Service terpilih akan dihapus dari draft konfigurasi. Klik Apply & Reload untuk menerapkan, atau Discard untuk membatalkan.',
      items: refs.map(r => `${r.host_name} / ${r.service_description}`),
      confirmText: `Delete ${refs.length} Service(s)`,
      danger: true
    });
    if (!ok) return;
  }
  const res = await fetch('/api/v1/config/services/bulk', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action, services: refs })
  });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  S.selectedManagedSvcs.clear();
  toast(`Bulk ${action}: ${d.affected} service(s) staged — click Apply & Reload`);
  await loadManage(); await loadMeta();
}

/* ====== TEMPLATES TAB (Instant Save) ====== */
function renderTemplatesTab(el, c) {
  const tpls = c.templates || [];
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">Service Check Templates (${tpls.length}) <span class="save-scope-pill instant">Instant Save</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="openSaveTplFromHostModal()">Save From Host</button>
          <button class="btn btn-sm primary" onclick="openTemplateForm(-1)">+ New Template</button>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Template</th><th>Services Included</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${tpls.length ? tpls.map((t, i) => `<tr>
          <td style="min-width:190px"><b>${esc(t.name)}</b><div class="name-sub">${esc(t.description || '')}</div></td>
          <td><div class="perf-chips">${(t.services||[]).map(s => `<span class="perf-chip" title="${esc(s.check_command)}">${esc(s.service_description)}</span>`).join('')}</div></td>
          <td class="actions" style="white-space:nowrap">
            <button class="btn btn-sm primary" onclick="openApplyTemplateModal([], '${esc(t.name)}')">Apply</button>
            <button class="btn btn-sm" onclick="openTemplateForm(${i})">Edit</button>
            <button class="btn btn-sm" onclick="openTemplateForm(${i}, true)">Clone</button>
            <button class="btn btn-sm danger" onclick="deleteManagedItem('templates','name=${encodeURIComponent(t.name)}','Template ${esc(t.name)}')">Delete</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="3" class="empty">No templates yet.</td></tr>'}
      </tbody></table></div>
    </div>`;
}

function openTemplateForm(idx, isClone) {
  const t = idx >= 0 ? S.managed.config.templates[idx] : {
    name: '', description: '',
    services: [{ service_description: 'HTTP', check_command: 'check_http', check_interval: 5, max_check_attempts: 3 }]
  };
  const lines = (t.services || []).map(s => `${s.service_description} | ${s.check_command} | ${s.check_interval||5}`).join('\n');
  openModal(`<h2>${isClone ? 'Clone Template' : (idx >= 0 ? 'Edit Template' : 'New Service Template')}</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill instant">Instant Save — langsung tersimpan tanpa reload Nagios</span></div>
    <div class="form-row"><label>Template Name *</label><input id="tpl-name" type="text" value="${esc(isClone ? t.name + '-copy' : t.name)}" ${idx>=0 && !isClone ? 'readonly' : ''}></div>
    <div class="form-row"><label>Description</label><input id="tpl-desc" type="text" value="${esc(t.description || '')}"></div>
    <div class="form-row"><label>Services (1 per line: <code class="code-chip">Service Name | check_command | interval_min</code>)</label>
      <textarea id="tpl-svcs" class="raw-editor" style="min-height:170px">${esc(lines)}</textarea>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveTemplateForm()">Save Template</button></div>`);
}
async function saveTemplateForm() {
  const name = document.getElementById('tpl-name').value.trim();
  const description = document.getElementById('tpl-desc').value.trim();
  const rawLines = document.getElementById('tpl-svcs').value.split('\n').map(l => l.trim()).filter(Boolean);
  const services = rawLines.map(line => {
    const parts = line.split('|').map(x => x.trim());
    return { service_description: parts[0] || '', check_command: parts[1] || '', check_interval: Number(parts[2]) || 5, retry_interval: 1, max_check_attempts: 3, check_period: '24x7' };
  });
  await apiPost('/api/v1/config/templates', { name, description, services }, 'Template saved (instant)', true);
}
function openSaveTplFromHostModal() {
  const hosts = S.managed.config.hosts || [];
  openModal(`<h2>Save Host's Services as Template</h2>
    <div class="form-row"><label>Source Host *</label>
      <select id="tpl-src-host">${hosts.map(h => `<option value="${esc(h.name)}">${esc(h.name)}</option>`).join('')}</select>
    </div>
    <div class="form-row"><label>New Template Name *</label><input id="tpl-new-name" type="text" placeholder="e.g. prod-app-standard"></div>
    <div class="form-row"><label>Description</label><input id="tpl-new-desc" type="text" placeholder="Optional description"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/templates/from-host',{host_name:document.getElementById('tpl-src-host').value,name:document.getElementById('tpl-new-name').value.trim(),description:document.getElementById('tpl-new-desc').value.trim()},'Template created (instant)',true)">Save Template</button></div>`);
}
function openApplyTemplateModal(preselectedHosts, preselectedTpl) {
  const tpls = S.managed.config.templates || [];
  const hosts = S.managed.config.hosts || [];
  const preSet = new Set(preselectedHosts || []);
  openModal(`<h2>Apply Service Template</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill draft">Creates Draft Services — requires Apply &amp; Reload</span></div>
    <div class="form-row"><label>Template *</label>
      <select id="ap-tpl">${tpls.map(t => `<option value="${esc(t.name)}" ${t.name===preselectedTpl?'selected':''}>${esc(t.name)} (${(t.services||[]).length} services)</option>`).join('')}</select>
    </div>
    <div class="form-row"><label>Target Hosts *</label>
      <div style="max-height:190px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${hosts.map(h => `<label class="chk-pill"><input type="checkbox" class="ap-host-chk" value="${esc(h.name)}" ${preSet.has(h.name)?'checked':''}> ${esc(h.name)}</label>`).join('')}
      </div>
    </div>
    <label class="chk-pill"><input type="checkbox" id="ap-overwrite"> Overwrite existing services with same name</label>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitApplyTemplate()">Apply Template</button></div>`);
}
async function submitApplyTemplate() {
  const template = document.getElementById('ap-tpl').value;
  const hosts = [...document.querySelectorAll('.ap-host-chk:checked')].map(c => c.value);
  const overwrite = document.getElementById('ap-overwrite').checked;
  if (!hosts.length) { toast('Select at least one host'); return; }
  const res = await fetch('/api/v1/config/templates/apply', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ template, hosts, overwrite })
  });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  closeModal();
  toast(`Applied: +${d.added} service(s), ${d.skipped} skipped — click Apply & Reload`);
  await loadManage(); await loadMeta();
}

/* ====== COMMANDS & GROUPS TABS ====== */
async function renderCommandsTab(el, c) {
  const dm = getDiffMaps();
  const sData = await (await fetch('/api/v1/scripts')).json();
  const scripts = sData.scripts || [];
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">Managed Commands (${c.commands.length}) <span class="save-scope-pill draft">Draft • Apply &amp; Reload</span></div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="quickRegisterNCPA()">+ NCPA Command</button>
          <button class="btn btn-sm primary" onclick="openCmdForm(-1)">+ Add Command</button>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Command Line</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${c.commands.length ? c.commands.map((cmd, i) => {
          const cd = dm.command.get(cmd.command_name);
          return `<tr class="${diffRowClass(cd)}"><td><b>${esc(cmd.command_name)}</b>${diffBadge(cd)}</td><td class="mono">${esc(cmd.command_line)}</td>
          <td class="actions"><button class="btn btn-sm" onclick="openCmdForm(${i})">Edit</button><button class="btn btn-sm" onclick="openCmdForm(${i},true)">Clone</button><button class="btn btn-sm danger" onclick="deleteManagedItem('commands','name=${encodeURIComponent(cmd.command_name)}','Command ${esc(cmd.command_name)}')">Delete</button></td></tr>`;
        }).join('') : '<tr><td colspan="3" class="empty">No managed commands.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">Custom Scripts (${scripts.length}) <span class="save-scope-pill instant">Instant Save to Disk</span></div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm primary" onclick="openScriptModal('','bash')">+ Bash</button>
          <button class="btn btn-sm" onclick="openScriptModal('','python')">+ Python</button>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Script</th><th>Path</th><th>Size</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${scripts.length ? scripts.map(sc => `<tr>
          <td><b>${esc(sc.name)}</b></td><td class="mono">${esc(sc.path)}</td><td class="mono">${sc.size_bytes} B</td>
          <td class="actions">
            <button class="btn btn-sm" onclick="openScriptModal('${esc(sc.name)}')">Edit</button>
            <button class="btn btn-sm" onclick="openTestScriptModal('${esc(sc.name)}')">Test</button>
            <button class="btn btn-sm primary" onclick="registerScriptAsCmd('${esc(sc.name)}','${esc(sc.path)}')">+ Cmd</button>
            <button class="btn btn-sm danger" onclick="deleteScript('${esc(sc.name)}')">Delete</button>
          </td></tr>`).join('') : '<tr><td colspan="4" class="empty">No custom scripts yet.</td></tr>'}
      </tbody></table></div>
    </div>`;
}

function renderGroupsManageTab(el, c) {
  const dm = getDiffMaps();
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head"><div class="panel-title">Hostgroups <span class="save-scope-pill draft">Draft • Apply &amp; Reload</span></div><button class="btn btn-sm primary" onclick="openGroupForm('hostgroups')">+ Hostgroup</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Alias</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${c.hostgroups.length ? c.hostgroups.map(g => {
          const gd = dm.hostgroup.get(g.group_name);
          return `<tr class="${diffRowClass(gd)}"><td><b>${esc(g.group_name)}</b>${diffBadge(gd)}</td><td>${esc(g.alias)}</td><td class="actions"><button class="btn btn-sm danger" onclick="deleteManagedItem('hostgroups','name=${encodeURIComponent(g.group_name)}','Hostgroup ${esc(g.group_name)}')">Delete</button></td></tr>`;
        }).join('') : '<tr><td colspan="3" class="empty">None</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-head"><div class="panel-title">Servicegroups</div><button class="btn btn-sm primary" onclick="openGroupForm('servicegroups')">+ Servicegroup</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Alias</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${c.servicegroups.length ? c.servicegroups.map(g => {
          const gd = dm.servicegroup.get(g.group_name);
          return `<tr class="${diffRowClass(gd)}"><td><b>${esc(g.group_name)}</b>${diffBadge(gd)}</td><td>${esc(g.alias)}</td><td class="actions"><button class="btn btn-sm danger" onclick="deleteManagedItem('servicegroups','name=${encodeURIComponent(g.group_name)}','Servicegroup ${esc(g.group_name)}')">Delete</button></td></tr>`;
        }).join('') : '<tr><td colspan="3" class="empty">None</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-head"><div class="panel-title">Contacts (auto-synced to Email Notifications)</div><button class="btn btn-sm primary" onclick="openContactForm()">+ Contact</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Alias</th><th>Email</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${c.contacts.length ? c.contacts.map(ct => {
          const cd = dm.contact.get(ct.contact_name);
          return `<tr class="${diffRowClass(cd)}"><td><b>${esc(ct.contact_name)}</b>${diffBadge(cd)}</td><td>${esc(ct.alias)}</td><td class="mono">${esc(ct.email)}</td><td class="actions"><button class="btn btn-sm danger" onclick="deleteManagedItem('contacts','name=${encodeURIComponent(ct.contact_name)}','Contact ${esc(ct.contact_name)}')">Delete</button></td></tr>`;
        }).join('') : '<tr><td colspan="4" class="empty">None</td></tr>'}
      </tbody></table></div>
    </div>`;
}

/* ====== NOTIFICATIONS TAB (Instant Save — clearly badged!) ====== */
async function renderNotificationsTab(el) {
  const data = await (await fetch('/api/v1/notifications/config')).json();
  const n = data.config || {};
  const hist = data.history || [];
  el.innerHTML = `
    <div class="callout-banner" style="background:var(--ok-bg);border-color:var(--ok);color:var(--ok-fg)">
      <div><b>Instant Save:</b> Pengaturan Email (SMTP) &amp; Webhook berjalan langsung di <b>Encore Gateway</b> — klik <b>Save &amp; Activate</b> langsung berlaku tanpa perlu <i>Apply &amp; Reload</i> Nagios.</div>
    </div>
    <div class="split-2">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Built-in Email Notification (SMTP) <span class="save-scope-pill instant">Instant</span></div>
          <label class="chk-pill"><input type="checkbox" id="nf-enabled" ${n.enabled?'checked':''}> Enable Email</label>
        </div>
        <div style="padding:16px">
          <div class="form-grid">
            <div class="form-row"><label>SMTP Host *</label><input id="nf-host" type="text" placeholder="smtp.gmail.com" value="${esc(n.smtp_host||'')}"></div>
            <div class="form-row"><label>Port &amp; TLS</label>
              <div style="display:flex;gap:6px">
                <input id="nf-port" type="number" value="${n.smtp_port||587}" style="width:90px">
                <select id="nf-tls" style="flex:1">
                  <option value="starttls" ${n.smtp_tls==='starttls'?'selected':''}>STARTTLS (587)</option>
                  <option value="tls" ${n.smtp_tls==='tls'?'selected':''}>SSL/TLS (465)</option>
                  <option value="none" ${n.smtp_tls==='none'?'selected':''}>Plain (25)</option>
                </select>
              </div>
            </div>
            <div class="form-row"><label>SMTP Username</label><input id="nf-user" type="text" value="${esc(n.smtp_user||'')}"></div>
            <div class="form-row"><label>SMTP Password / App Password</label><input id="nf-pass" type="password" value="${esc(n.smtp_pass||'')}" placeholder="Leave unchanged if masked"></div>
            <div class="form-row"><label>From Address *</label><input id="nf-from" type="text" placeholder="alerts@domain.com" value="${esc(n.from_address||'')}"></div>
            <div class="form-row"><label>From Name</label><input id="nf-from-name" type="text" value="${esc(n.from_name||'Encore Monitor')}"></div>
            <div class="form-row full"><label>Recipients (comma-separated emails)</label><input id="nf-rcpt" type="text" placeholder="ops@company.com, admin@company.com" value="${esc((n.recipients||[]).join(', '))}"></div>
            <div class="form-row"><label>Dashboard URL (link in email)</label><input id="nf-url" type="text" placeholder="http://server:8080" value="${esc(n.dashboard_url||'')}"></div>
            <div class="form-row"><label>Cooldown (minutes per object)</label><input id="nf-cool" type="number" min="0" value="${n.cooldown_min ?? 10}"></div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px">
            <label class="chk-pill"><input type="checkbox" id="nf-insecure" ${n.smtp_insecure_tls?'checked':''}> Skip TLS Verify (Self-Signed)</label>
            <label class="chk-pill"><input type="checkbox" id="nf-contacts" ${n.include_managed_contacts!==false?'checked':''}> Include Manage Contacts</label>
            <label class="chk-pill"><input type="checkbox" id="nf-hard" ${n.hard_only!==false?'checked':''}> HARD State Only</label>
            <label class="chk-pill"><input type="checkbox" id="nf-down" ${n.notify_down!==false?'checked':''}> DOWN</label>
            <label class="chk-pill"><input type="checkbox" id="nf-crit" ${n.notify_critical!==false?'checked':''}> CRITICAL</label>
            <label class="chk-pill"><input type="checkbox" id="nf-warn" ${n.notify_warning?'checked':''}> WARNING</label>
            <label class="chk-pill"><input type="checkbox" id="nf-rec" ${n.notify_recovery!==false?'checked':''}> RECOVERY</label>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-sm primary" onclick="saveNotifyConfig()">Save &amp; Activate</button>
            <button class="btn btn-sm" onclick="testNotify('email')">Send Test Email</button>
          </div>
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Webhook (Telegram / Slack / Discord) <span class="save-scope-pill instant">Instant</span></div>
            <label class="chk-pill"><input type="checkbox" id="nf-wh-en" ${n.webhook_enabled?'checked':''}> Enable Webhook</label>
          </div>
          <div style="padding:16px">
            <div class="form-row"><label>Channel Type</label>
              <select id="nf-wh-type">
                <option value="telegram" ${n.webhook_type==='telegram'?'selected':''}>Telegram Bot API</option>
                <option value="slack" ${n.webhook_type==='slack'?'selected':''}>Slack Incoming Webhook</option>
                <option value="discord" ${n.webhook_type==='discord'?'selected':''}>Discord Webhook</option>
                <option value="generic" ${n.webhook_type==='generic'?'selected':''}>Generic JSON Webhook</option>
              </select>
            </div>
            <div class="form-row"><label>Webhook URL</label><input id="nf-wh-url" type="text" placeholder="https://api.telegram.org/botTOKEN/sendMessage" value="${esc(n.webhook_url||'')}"></div>
            <div class="form-row"><label>Telegram Chat ID (Telegram only)</label><input id="nf-wh-chat" type="text" placeholder="-1001234567890" value="${esc(n.webhook_chat_id||'')}"></div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn btn-sm primary" onclick="saveNotifyConfig()">Save &amp; Activate</button>
              <button class="btn btn-sm" onclick="testNotify('webhook')">Send Test Webhook</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div class="panel-title">Recent Delivery Log (${hist.length})</div></div>
          <div class="table-wrap"><table><thead><tr><th>Time</th><th>Channel</th><th>Status</th><th>Detail</th></tr></thead><tbody>
            ${hist.length ? hist.slice(0, 12).map(h => `<tr>
              <td class="mono">${relTime(Math.floor(Date.parse(h.time)/1000))}</td>
              <td><span class="flag-tag">${esc(h.channel)}</span></td>
              <td>${h.status==='sent'?'<span class="badge c-ok">SENT</span>':'<span class="badge c-crit">FAIL</span>'}</td>
              <td class="output-cell" title="${esc(h.error || h.subject)}">${esc(h.error || h.subject)}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="empty">No notifications sent yet</td></tr>'}
          </tbody></table></div>
        </div>
      </div>
    </div>`;
}

async function saveNotifyConfig() {
  const payload = {
    enabled: document.getElementById('nf-enabled').checked,
    smtp_host: document.getElementById('nf-host').value.trim(),
    smtp_port: Number(document.getElementById('nf-port').value) || 587,
    smtp_tls: document.getElementById('nf-tls').value,
    smtp_insecure_tls: document.getElementById('nf-insecure').checked,
    smtp_user: document.getElementById('nf-user').value.trim(),
    smtp_pass: document.getElementById('nf-pass').value,
    from_address: document.getElementById('nf-from').value.trim(),
    from_name: document.getElementById('nf-from-name').value.trim(),
    recipients: document.getElementById('nf-rcpt').value.split(',').map(x => x.trim()).filter(Boolean),
    include_managed_contacts: document.getElementById('nf-contacts').checked,
    hard_only: document.getElementById('nf-hard').checked,
    notify_down: document.getElementById('nf-down').checked,
    notify_critical: document.getElementById('nf-crit').checked,
    notify_warning: document.getElementById('nf-warn').checked,
    notify_recovery: document.getElementById('nf-rec').checked,
    cooldown_min: Number(document.getElementById('nf-cool').value) || 0,
    dashboard_url: document.getElementById('nf-url').value.trim(),
    webhook_enabled: document.getElementById('nf-wh-en').checked,
    webhook_type: document.getElementById('nf-wh-type').value,
    webhook_url: document.getElementById('nf-wh-url').value.trim(),
    webhook_chat_id: document.getElementById('nf-wh-chat').value.trim()
  };
  const res = await fetch('/api/v1/notifications/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const d = await res.json();
  toast(res.ok ? 'Saved & active immediately (no Nagios reload needed)' : ('Error: ' + d.error));
}

async function testNotify(channel) {
  await saveNotifyConfig();
  toast(`Sending test ${channel}...`);
  const res = await fetch('/api/v1/notifications/test', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ channel }) });
  const d = await res.json();
  toast(res.ok ? `Test ${channel} sent!` : (`Test failed: ${d.error}`));
  renderNotificationsTab(document.getElementById('manage-content'));
}

/* ====== LOCALHOST HELPERS ====== */
async function openLocalhostRawModal() {
  const data = await (await fetch('/api/v1/config/localhost')).json();
  if (!data.configured || !data.exists) { toast('localhost.cfg not found'); return; }
  openModal(`<h2>${esc(data.path)} ${data.adopted?'<span class="badge c-ok">ADOPTED</span>':'<span class="badge c-warn">STANDALONE</span>'}</h2>
    <textarea id="lh-raw-editor" class="raw-editor">${esc(data.raw)}</textarea>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn primary" onclick="saveLocalhostRaw()">Save Raw &amp; Auto-Reload</button>
    </div>`);
}
async function adoptLocalhost() {
  const ok = await encoreConfirm({
    title: 'Adopt localhost.cfg?',
    message: 'Host dan service di localhost.cfg akan dipindahkan ke Encore Managed Config. File asli akan dibackup otomatis.',
    confirmText: 'Adopt & Reload'
  });
  if (!ok) return;
  const con = document.getElementById('validate-console');
  con.style.display = 'block'; con.textContent = 'Adopting & validating...';
  const res = await fetch('/api/v1/config/localhost/adopt', { method: 'POST' });
  const d = await res.json();
  con.textContent = (d.error ? 'ERROR: ' + d.error + '\n\n' : `ADOPTED (${d.hosts} host, ${d.services} services)\n\n`) + (d.output || '');
  toast(res.ok ? 'Localhost adopted & reloaded!' : ('Adopt failed: ' + d.error));
  if (res.ok) { await loadManage(); setTimeout(refreshAll, 1200); }
}
async function saveLocalhostRaw() {
  const ta = document.getElementById('lh-raw-editor'); if (!ta) return;
  const res = await fetch('/api/v1/config/localhost', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({raw: ta.value}) });
  const d = await res.json();
  toast(res.ok ? 'Saved & reloaded!' : ('Failed: ' + d.error));
  if (res.ok) closeModal();
}

/* ====== SECRETS TAB (Auto-Reload) ====== */
async function renderSecretsTab(el) {
  const data = await (await fetch('/api/v1/secrets')).json();
  const list = data.secrets || [];
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">Resource Secrets (<code class="code-chip">$USER2$..$USER32$</code>) <span class="save-scope-pill auto">Auto-Reload Nagios</span></div>
        <button class="btn btn-sm primary" onclick="openSecretModal()">+ Set Secret</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Macro</th><th>Value (Masked)</th><th>Usage</th><th style="text-align:right">Actions</th></tr></thead><tbody>
        ${list.length ? list.map(m => `<tr>
          <td class="mono" style="color:var(--text);font-weight:700">${esc(m.key)}</td>
          <td class="mono">${esc(m.masked)}</td>
          <td class="name-sub">${esc(m.hint || 'Custom secret macro')}</td>
          <td class="actions">${m.read_only ? '<span class="flag-tag">READ-ONLY</span>' : `<button class="btn btn-sm" onclick="openSecretModal('${esc(m.key)}')">Update</button><button class="btn btn-sm danger" onclick="deleteSecret('${esc(m.key)}')">Delete</button>`}</td>
        </tr>`).join('') : '<tr><td colspan="4" class="empty">No macros found.</td></tr>'}
      </tbody></table></div>
    </div>`;
}
function openSecretModal(key) {
  openModal(`<h2>${key ? 'Update ' + esc(key) : 'Set Resource Secret'}</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill auto">Auto-Reload — menyimpan ke resource.cfg &amp; reload Nagios otomatis</span></div>
    <div class="form-row"><label>Macro Key ($USER2$ .. $USER32$)</label><input id="sec-key" type="text" value="${esc(key || '$USER2$')}" ${key?'readonly':''}></div>
    <div class="form-row"><label>Secret Value (e.g. NCPA Token)</label><input id="sec-val" type="password" placeholder="Enter secret token..."></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveSecretModal()">Save &amp; Auto-Reload</button></div>`);
}
async function saveSecretModal() {
  const key = document.getElementById('sec-key').value.trim();
  const value = document.getElementById('sec-val').value;
  const res = await fetch('/api/v1/secrets', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key, value}) });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + (d.error || res.statusText)); return; }
  closeModal(); toast('Secret saved & Nagios reloading'); loadManage();
}
async function deleteSecret(key) {
  const ok = await encoreConfirm({ title: `Delete Secret ${key}?`, message: 'Macro secret akan dihapus dari resource.cfg dan Nagios akan otomatis reload.', confirmText: 'Delete Secret', danger: true });
  if (!ok) return;
  const res = await fetch('/api/v1/secrets?key=' + encodeURIComponent(key), { method:'DELETE' });
  if (res.ok) { toast('Deleted & reloading'); loadManage(); }
}

/* ====== SYSTEM TABS ====== */
function setSysTab(t) { S.sysTab = t; ['controls','backups','audit'].forEach(k => document.getElementById('stab-'+k)?.classList.toggle('active', k===t)); loadSystem(); }
async function loadSystem() {
  const el = document.getElementById('system-content');
  if (S.sysTab === 'controls') {
    const p = (S.summary && S.summary.program) || {};
    el.innerHTML = `<div class="panel"><div class="toggle-grid">
      <div class="toggle-card"><div><b>Notifications</b><div class="name-sub">${p.notifications_enabled?'Enabled':'Disabled'}</div></div>
        <button class="btn btn-sm" onclick="sendCmd('${p.notifications_enabled?'DISABLE_NOTIFICATIONS':'ENABLE_NOTIFICATIONS'}','Toggle notifications')">${p.notifications_enabled?'Disable':'Enable'}</button></div>
      <div class="toggle-card"><div><b>Service Checks</b><div class="name-sub">${p.execute_service_checks?'Enabled':'Disabled'}</div></div>
        <button class="btn btn-sm" onclick="sendCmd('${p.execute_service_checks?'STOP_EXECUTING_SVC_CHECKS':'START_EXECUTING_SVC_CHECKS'}','Toggle service checks')">${p.execute_service_checks?'Stop':'Start'}</button></div>
      <div class="toggle-card"><div><b>Host Checks</b><div class="name-sub">${p.execute_host_checks?'Enabled':'Disabled'}</div></div>
        <button class="btn btn-sm" onclick="sendCmd('${p.execute_host_checks?'STOP_EXECUTING_HOST_CHECKS':'START_EXECUTING_HOST_CHECKS'}','Toggle host checks')">${p.execute_host_checks?'Stop':'Start'}</button></div>
      <div class="toggle-card"><div><b>Flap Detection</b><div class="name-sub">${p.flap_detection_enabled?'Enabled':'Disabled'}</div></div>
        <button class="btn btn-sm" onclick="sendCmd('${p.flap_detection_enabled?'DISABLE_FLAP_DETECTION':'ENABLE_FLAP_DETECTION'}','Toggle flap')">${p.flap_detection_enabled?'Disable':'Enable'}</button></div>
      <div class="toggle-card"><div><b>Legacy localhost.cfg</b><div class="name-sub">Raw config access</div></div>
        <button class="btn btn-sm" onclick="openLocalhostRawModal()">Inspect Raw</button></div>
    </div></div>`;
  } else if (S.sysTab === 'backups') {
    const backups = (await (await fetch('/api/v1/config/backups')).json()).backups || [];
    el.innerHTML = `<div class="panel"><div class="table-wrap"><table><thead><tr><th>Backup</th><th>Timestamp</th><th>Size</th><th style="text-align:right">Action</th></tr></thead><tbody>
      ${backups.length ? backups.map(b => `<tr><td class="mono">${esc(b.name)}</td><td class="mono">${esc(b.timestamp)}</td><td class="mono">${b.size_bytes} B</td><td class="actions"><button class="btn btn-sm" onclick="rollbackBackup('${esc(b.name)}')">Rollback</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">No backups yet</td></tr>'}
    </tbody></table></div></div>`;
  } else {
    const audit = (await (await fetch('/api/v1/audit?limit=60')).json()).entries || [];
    el.innerHTML = `<div class="panel"><div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
      ${audit.length ? audit.map(a => `<tr><td class="mono">${esc(a.time)}</td><td><b>${esc(a.action)}</b></td><td class="mono">${esc(a.target)}</td><td class="mono">${esc(a.detail||'')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No audit entries</td></tr>'}
    </tbody></table></div></div>`;
  }
}

/* ====== CRUD, CLONE & SCRIPTS MODALS ====== */
function openHostForm(idx) {
  const h = idx>=0 ? S.managed.config.hosts[idx] : { name:'', alias:'', address:'', check_command:'check-host-alive', check_interval:5, retry_interval:1, max_check_attempts:3, check_period:'24x7', contacts:'', hostgroups:[], enabled:true };
  const tpls = S.managed.config.templates || [];
  openModal(`<h2>${idx>=0?'Edit Host':'Add Host'}</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill draft">Draft — klik Apply &amp; Reload setelah selesai mengedit</span></div>
    <div class="form-grid">
      <div class="form-row"><label>Host Name *</label><input id="f-h-name" type="text" value="${esc(h.name)}" ${idx>=0?'readonly':''}></div>
      <div class="form-row"><label>IP / Address *</label><input id="f-h-addr" type="text" value="${esc(h.address)}"></div>
      <div class="form-row"><label>Alias</label><input id="f-h-alias" type="text" value="${esc(h.alias)}"></div>
      <div class="form-row"><label>Check Command</label><input id="f-h-cmd" type="text" value="${esc(h.check_command)}"></div>
      <div class="form-row"><label>Hostgroups</label><input id="f-h-hg" type="text" value="${esc((h.hostgroups||[]).join(','))}"></div>
      <div class="form-row"><label>Contacts</label><input id="f-h-ct" type="text" value="${esc(h.contacts)}"></div>
      <div class="form-row"><label>Interval (min)</label><input id="f-h-int" type="number" value="${h.check_interval||5}"></div>
      <div class="form-row"><label>Max Attempts</label><input id="f-h-att" type="number" value="${h.max_check_attempts||3}"></div>
    </div>
    ${idx < 0 && tpls.length ? `<div class="form-row"><label>Apply Service Templates (optional)</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${tpls.map(t => `<label class="chk-pill"><input type="checkbox" class="f-h-tpl" value="${esc(t.name)}"> ${esc(t.name)} (${(t.services||[]).length})</label>`).join('')}
      </div></div>` : ''}
    <label class="chk-pill"><input type="checkbox" id="f-h-en" ${h.enabled!==false?'checked':''}> Enabled</label>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveHostForm()">Save Draft</button></div>`);
}
async function saveHostForm() {
  const name = document.getElementById('f-h-name').value.trim();
  const selTpls = [...document.querySelectorAll('.f-h-tpl:checked')].map(c => c.value);
  const res = await fetch('/api/v1/config/hosts', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      name, address: document.getElementById('f-h-addr').value.trim(),
      alias: document.getElementById('f-h-alias').value.trim(), check_command: document.getElementById('f-h-cmd').value.trim(),
      hostgroups: document.getElementById('f-h-hg').value.split(',').map(x=>x.trim()).filter(Boolean),
      contacts: document.getElementById('f-h-ct').value.trim(),
      check_interval: Number(document.getElementById('f-h-int').value)||5, retry_interval: 1,
      max_check_attempts: Number(document.getElementById('f-h-att').value)||3, check_period: '24x7',
      enabled: document.getElementById('f-h-en').checked
    })
  });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + (d.error || res.statusText)); return; }
  for (const tpl of selTpls) {
    await fetch('/api/v1/config/templates/apply', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ template: tpl, hosts: [name], overwrite: false })
    });
  }
  closeModal();
  S.expandedHosts.add(name);
  toast(selTpls.length ? `Host draft saved + ${selTpls.length} template(s) applied` : 'Host draft saved — click Apply & Reload');
  await loadManage(); await loadMeta();
}
function openCloneHostModal(srcName) {
  openModal(`<h2>Clone Host: ${esc(srcName)}</h2>
    <div class="form-row"><label>New Host Name *</label><input id="c-h-name" type="text" placeholder="${esc(srcName)}-clone"></div>
    <div class="form-row"><label>New IP / Address *</label><input id="c-h-addr" type="text" placeholder="10.0.0.x"></div>
    <div class="form-row"><label>New Alias</label><input id="c-h-alias" type="text"></div>
    <label class="chk-pill"><input type="checkbox" id="c-h-svcs" checked> Clone all services of ${esc(srcName)}</label>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitCloneHost('${esc(srcName)}')">Clone Draft</button></div>`);
}
async function submitCloneHost(srcName) {
  await apiPost('/api/v1/config/hosts/clone', {
    source_name: srcName, new_name: document.getElementById('c-h-name').value.trim(),
    new_address: document.getElementById('c-h-addr').value.trim(), new_alias: document.getElementById('c-h-alias').value.trim(),
    include_services: document.getElementById('c-h-svcs').checked
  }, 'Host cloned');
}
async function openSvcForm(idx, preHost) {
  await ensureCatalogCommands();
  const s = idx>=0 ? S.managed.config.services[idx] : { host_name: preHost || '', service_description:'', check_command:'check_http', check_interval:5, retry_interval:1, max_check_attempts:3, check_period:'24x7', contacts:'', servicegroups:[], enabled:true };
  const hostOpts = S.managed.config.hosts.map(h => `<option value="${esc(h.name)}">`).join('');
  const cmdOpts = (S.catalogCmds || []).map(c => `<option value="${esc(c.example || c.command_name)}">${esc(c.command_name)} (${esc(c.source)})</option>`).join('');
  openModal(`<h2>${idx>=0?'Edit Service':'Add Service'}</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill draft">Draft — klik Apply &amp; Reload setelah selesai</span></div>
    <div class="presets">
      <button class="btn btn-sm" onclick="applySvcPreset('HTTP','check_http')">HTTP</button>
      <button class="btn btn-sm" onclick="applySvcPreset('TCP 443','check_tcp!443')">TCP</button>
      <button class="btn btn-sm" onclick="applySvcPreset('PING','check_ping!100.0,20%!500.0,60%')">Ping</button>
      <button class="btn btn-sm" onclick="applySvcPreset('SSH','check_ssh')">SSH</button>
      <button class="btn btn-sm" onclick="applySvcPreset('NCPA CPU','check_ncpa!cpu/percent!-w 80 -c 90')">NCPA CPU</button>
      <button class="btn btn-sm" onclick="applySvcPreset('NCPA RAM','check_ncpa!memory/virtual!-w 80 -c 90')">NCPA RAM</button>
      <button class="btn btn-sm" onclick="applySvcPreset('NCPA Disk','check_ncpa!disk/logical/|/used_percent!-w 80 -c 90')">NCPA Disk</button>
      <button class="btn btn-sm" onclick="applySvcPreset('NCPA Procs','check_ncpa!processes!-w 250 -c 400')">NCPA Procs</button>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Host *</label><input id="f-s-host" list="managed-host-list" type="text" value="${esc(s.host_name)}"><datalist id="managed-host-list">${hostOpts}</datalist></div>
      <div class="form-row"><label>Service *</label><input id="f-s-desc" type="text" value="${esc(s.service_description)}"></div>
      <div class="form-row full"><label>Check Command * (autocomplete from active commands)</label>
        <input id="f-s-cmd" list="active-cmd-list" type="text" value="${esc(s.check_command)}" oninput="updateCmdHint()">
        <datalist id="active-cmd-list">${cmdOpts}</datalist>
        <div id="f-s-cmd-hint" class="name-sub" style="margin-top:3px"></div>
      </div>
      <div class="form-row"><label>Servicegroups</label><input id="f-s-sg" type="text" value="${esc((s.servicegroups||[]).join(','))}"></div>
      <div class="form-row"><label>Contacts</label><input id="f-s-ct" type="text" value="${esc(s.contacts)}"></div>
      <div class="form-row"><label>Interval (min)</label><input id="f-s-int" type="number" value="${s.check_interval||5}"></div>
      <div class="form-row"><label>Max Attempts</label><input id="f-s-att" type="number" value="${s.max_check_attempts||3}"></div>
    </div>
    <label class="chk-pill"><input type="checkbox" id="f-s-en" ${s.enabled!==false?'checked':''}> Enabled</label>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveSvcForm()">Save Draft</button></div>`);
  updateCmdHint();
}
function updateCmdHint() {
  const val = (document.getElementById('f-s-cmd')?.value || '').trim();
  const base = val.split('!')[0];
  const hint = document.getElementById('f-s-cmd-hint');
  if (!hint || !base) return;
  const found = (S.catalogCmds || []).find(c => c.command_name === base);
  if (found) hint.innerHTML = `<span style="color:var(--ok-fg)">✓ Defined</span> (${esc(found.source)}) — <span class="mono">${esc(found.command_line)}</span>`;
  else if ((S.catalogCmds || []).length > 0) hint.innerHTML = `<span style="color:var(--warn-fg)">⚠ Command "${esc(base)}" not found in active catalog yet</span>`;
}
function applySvcPreset(desc, cmd) {
  if (!document.getElementById('f-s-desc').value) document.getElementById('f-s-desc').value = desc;
  document.getElementById('f-s-cmd').value = cmd;
  updateCmdHint();
}
async function saveSvcForm() {
  const hn = document.getElementById('f-s-host').value.trim();
  S.expandedHosts.add(hn);
  await apiPost('/api/v1/config/services', {
    host_name: hn, service_description: document.getElementById('f-s-desc').value.trim(),
    check_command: document.getElementById('f-s-cmd').value.trim(),
    servicegroups: document.getElementById('f-s-sg').value.split(',').map(x=>x.trim()).filter(Boolean),
    contacts: document.getElementById('f-s-ct').value.trim(),
    check_interval: Number(document.getElementById('f-s-int').value)||5, retry_interval: 1,
    max_check_attempts: Number(document.getElementById('f-s-att').value)||3, check_period: '24x7',
    enabled: document.getElementById('f-s-en').checked
  }, 'Service draft saved');
}
function openCloneSvcModal(srcHost, srcDesc) {
  openModal(`<h2>Clone Service: ${esc(srcHost)} / ${esc(srcDesc)}</h2>
    <div class="form-row"><label>Target Host *</label><input id="c-s-host" type="text" value="${esc(srcHost)}"></div>
    <div class="form-row"><label>New Description *</label><input id="c-s-desc" type="text" value="${esc(srcDesc)}-copy"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/services/clone',{source_host:'${esc(srcHost)}',source_description:'${esc(srcDesc)}',target_host:document.getElementById('c-s-host').value.trim(),target_description:document.getElementById('c-s-desc').value.trim()},'Service cloned')">Clone Draft</button></div>`);
}
function openCmdForm(idx, isClone) {
  const c = idx>=0 ? S.managed.config.commands[idx] : { command_name:'', command_line:'$USER1$/check_http -H $HOSTADDRESS$' };
  openModal(`<h2>${isClone?'Clone Command':(idx>=0?'Edit Command':'Add Command')}</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill draft">Draft — requires Apply &amp; Reload</span></div>
    <div class="form-row"><label>Name *</label><input id="f-c-name" type="text" value="${esc(isClone?c.command_name+'_copy':c.command_name)}"></div>
    <div class="form-row"><label>Command Line *</label><input id="f-c-line" type="text" value="${esc(c.command_line)}"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/commands',{command_name:document.getElementById('f-c-name').value.trim(),command_line:document.getElementById('f-c-line').value.trim()},'Command draft saved')">Save Draft</button></div>`);
}
function openGroupForm(kind) {
  openModal(`<h2>Add ${kind==='hostgroups'?'Hostgroup':'Servicegroup'}</h2>
    <div class="form-row"><label>Name *</label><input id="f-g-name" type="text"></div>
    <div class="form-row"><label>Alias</label><input id="f-g-alias" type="text"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/${kind}',{group_name:document.getElementById('f-g-name').value.trim(),alias:document.getElementById('f-g-alias').value.trim()},'Group draft saved')">Save Draft</button></div>`);
}
function openContactForm() {
  openModal(`<h2>Add Contact</h2>
    <div class="form-row"><label>Name *</label><input id="f-ct-name" type="text"></div>
    <div class="form-row"><label>Alias</label><input id="f-ct-alias" type="text"></div>
    <div class="form-row"><label>Email</label><input id="f-ct-email" type="text"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/contacts',{contact_name:document.getElementById('f-ct-name').value.trim(),alias:document.getElementById('f-ct-alias').value.trim(),email:document.getElementById('f-ct-email').value.trim()},'Contact draft saved')">Save Draft</button></div>`);
}
async function openScriptModal(name, kind) {
  let content = '';
  if (name) content = (await (await fetch('/api/v1/scripts/content?name=' + encodeURIComponent(name))).json()).content || '';
  else if (kind === 'python') content = `#!/usr/bin/env python3\nimport sys\nhost = sys.argv[1] if len(sys.argv) > 1 else "localhost"\nprint(f"OK - python check {host} | val=1;5;10")\nsys.exit(0)\n`;
  else content = `#!/bin/sh\nHOST="\${1:-localhost}"\necho "OK - check \$HOST | latency=1.2ms;50;100"\nexit 0\n`;
  openModal(`<h2>${name?'Edit '+esc(name):'New Script'}</h2>
    <div style="margin-bottom:10px"><span class="save-scope-pill instant">Instant Save to Disk (auto chmod +x)</span></div>
    <div class="form-row"><label>Filename</label><input id="sc-name" type="text" value="${esc(name||(kind==='python'?'check_custom.py':'check_custom.sh'))}" ${name?'readonly':''}></div>
    <div class="form-row"><label>Content</label><textarea id="sc-body" class="raw-editor">${esc(content)}</textarea></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveScriptModal()">Save Script</button></div>`);
}
async function saveScriptModal() {
  const res = await fetch('/api/v1/scripts', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:document.getElementById('sc-name').value.trim(), content:document.getElementById('sc-body').value}) });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  closeModal(); toast('Script saved to disk (instant)'); loadManage();
}
async function deleteScript(name) {
  const ok = await encoreConfirm({ title: `Delete Script "${name}"?`, message: 'File script akan dihapus permanen dari disk.', confirmText: 'Delete Script', danger: true });
  if (ok && (await fetch('/api/v1/scripts?name='+encodeURIComponent(name), {method:'DELETE'})).ok) { toast('Script deleted'); loadManage(); }
}
function openTestScriptModal(name) {
  openModal(`<h2>Test: ${esc(name)}</h2>
    <div class="form-row"><label>Args</label><input id="sc-test-args" type="text" placeholder="127.0.0.1"></div>
    <pre class="console-out" id="sc-test-out" style="display:block;margin:8px 0">Click Run Test...</pre>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Close</button><button class="btn primary" onclick="runScriptTest('${esc(name)}')">Run Test</button></div>`);
}
async function runScriptTest(name) {
  const el = document.getElementById('sc-test-out'); el.textContent = 'Running...';
  const d = await (await fetch('/api/v1/scripts/test', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, args:document.getElementById('sc-test-args').value.trim()}) })).json();
  el.textContent = `Exit: ${d.exit_code} (${d.duration_ms}ms)\nSTDOUT:\n${d.stdout||'(empty)'}\nSTDERR:\n${d.stderr||'(empty)'}`;
}
function registerScriptAsCmd(name, fullPath) {
  openModal(`<h2>Register as Command</h2>
    <div class="form-row"><label>Command Name</label><input id="f-c-name" type="text" value="${esc(name.replace(/\.(sh|py|pl)$/,''))}"></div>
    <div class="form-row"><label>Command Line</label><input id="f-c-line" type="text" value="${esc(fullPath)} $HOSTADDRESS$ $ARG1$"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/commands',{command_name:document.getElementById('f-c-name').value.trim(),command_line:document.getElementById('f-c-line').value.trim()},'Command registered')">Register Draft</button></div>`);
}
async function quickRegisterNCPA() {
  S.catalogCmds = [];
  await apiPost('/api/v1/config/commands', {
    command_name: 'check_ncpa',
    command_line: "$USER1$/check_ncpa.py -H $HOSTADDRESS$ -t '$USER2$' -P 5693 -M $ARG1$ $ARG2$"
  }, 'check_ncpa registered using $USER2$');
}

async function apiPost(url, payload, okMsg, isInstant) {
  try {
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    closeModal(); S.catalogCmds = [];
    toast(isInstant ? okMsg : (okMsg + ' — click Apply & Reload'));
    if (S.view === 'manage') await loadManage();
    await loadMeta();
  } catch (e) { toast('Error: ' + e.message); }
}
async function deleteManagedHost(name) {
  const ok = await encoreConfirm({ title: `Delete Host "${name}"?`, message: 'Host beserta seluruh service di bawahnya akan dihapus dari draft konfigurasi.', items: [name], confirmText: 'Delete Host', danger: true });
  if (ok) await deleteManagedItem('hosts', 'name='+encodeURIComponent(name));
}
async function deleteManagedSvc(host, desc) {
  const ok = await encoreConfirm({ title: `Delete Service "${desc}"?`, message: `Service pada host ${host} akan dihapus dari draft konfigurasi.`, items: [`${host} / ${desc}`], confirmText: 'Delete Service', danger: true });
  if (ok) await deleteManagedItem('services', `host=${encodeURIComponent(host)}&description=${encodeURIComponent(desc)}`);
}
async function deleteManagedItem(kind, qs, confirmLabel) {
  if (confirmLabel) {
    const ok = await encoreConfirm({ title: `Delete ${confirmLabel}?`, message: 'Item ini akan dihapus dari konfigurasi.', confirmText: 'Delete', danger: true });
    if (!ok) return;
  }
  const res = await fetch(`/api/v1/config/${kind}?${qs}`, { method:'DELETE' });
  if (!res.ok) { toast('Delete failed'); return; }
  S.catalogCmds = [];
  toast(kind === 'templates' ? 'Template deleted (instant)' : 'Deleted from draft — click Apply & Reload');
  await loadManage(); await loadMeta();
}
async function runValidate(apply) {
  const con = document.getElementById('validate-console');
  if (con) { con.style.display = 'block'; con.textContent = apply ? 'Applying & reloading...' : 'Validating...'; }
  const res = await fetch(apply ? '/api/v1/config/apply' : '/api/v1/config/validate', { method:'POST' });
  const d = await res.json();
  if (con) con.textContent = (d.error ? 'ERROR: '+d.error+'\n\n' : 'OK\n\n') + (d.output||'');
  toast(res.ok ? (apply ? 'Applied & reloading Nagios!' : 'Configuration valid!') : 'Validation failed');
  if (res.ok && apply) { if (S.view === 'manage') await loadManage(); setTimeout(refreshAll, 1400); }
}
async function rollbackBackup(name) {
  const ok = await encoreConfirm({ title: `Rollback to ${name}?`, message: 'Konfigurasi saat ini akan diganti dengan snapshot backup ini dan Nagios akan langsung reload.', confirmText: 'Rollback & Reload', danger: true });
  if (!ok) return;
  const res = await fetch('/api/v1/config/rollback', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({backup:name}) });
  toast(res.ok ? 'Rolled back & reloading!' : 'Rollback failed');
  if (res.ok) { await loadSystem(); setTimeout(refreshAll, 1400); }
}
