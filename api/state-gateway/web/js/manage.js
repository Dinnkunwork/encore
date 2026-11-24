function setManageTab(mt) {
  S.manageTab = mt;
  ['objects','localhost','commands','groups','secrets'].forEach(t => {
    const el = document.getElementById('mtab-' + t);
    if (el) el.classList.toggle('active', t === mt);
  });
  loadManage();
}

async function loadManage() {
  S.managed = await (await fetch('/api/v1/config')).json();
  const el = document.getElementById('manage-content');
  const c = S.managed.config;

  if (S.manageTab === 'localhost') { await renderLocalhostTab(el); return; }
  if (S.manageTab === 'secrets') { await renderSecretsTab(el); return; }
  if (!S.managed.enabled) {
    el.innerHTML = `<div class="panel"><div class="empty">Config management disabled. Start gateway with <code class="code-chip">-managed-dir /usr/local/nagios/etc/encore.d</code>.</div></div>`;
    return;
  }

  if (S.manageTab === 'objects') {
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Hosts (${c.hosts.length})</div><button class="btn btn-sm primary" onclick="openHostForm(-1)">+ Add Host</button></div>
        <div class="table-wrap"><table><thead><tr><th>Host</th><th>Address</th><th>Command</th><th>Groups</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>
          ${c.hosts.length ? c.hosts.map((h, i) => `<tr>
            <td><b>${esc(h.name)}</b><div class="name-sub">${esc(h.alias)}</div></td>
            <td class="mono">${esc(h.address)}</td><td class="mono">${esc(h.check_command)}</td>
            <td class="mono">${esc((h.hostgroups||[]).join(', ')||'-')}</td>
            <td>${h.enabled?'<span class="badge c-ok">ON</span>':'<span class="badge c-pend">OFF</span>'}</td>
            <td class="actions">
              <button class="btn btn-sm" onclick="openHostForm(${i})">Edit</button>
              <button class="btn btn-sm" onclick="openCloneHostModal('${esc(h.name)}')">Clone</button>
              <button class="btn btn-sm danger" onclick="deleteManagedHost('${esc(h.name)}')">Delete</button>
            </td></tr>`).join('') : '<tr><td colspan="6" class="empty">No managed hosts yet.</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Services (${c.services.length})</div><button class="btn btn-sm primary" onclick="openSvcForm(-1)">+ Add Service</button></div>
        <div class="table-wrap"><table><thead><tr><th>Host</th><th>Service</th><th>Command</th><th>Groups</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>
          ${c.services.length ? c.services.map((s, i) => `<tr>
            <td><b>${esc(s.host_name)}</b></td><td>${esc(s.service_description)}</td>
            <td class="mono">${esc(s.check_command)}</td><td class="mono">${esc((s.servicegroups||[]).join(', ')||'-')}</td>
            <td>${s.enabled?'<span class="badge c-ok">ON</span>':'<span class="badge c-pend">OFF</span>'}</td>
            <td class="actions">
              <button class="btn btn-sm" onclick="openSvcForm(${i})">Edit</button>
              <button class="btn btn-sm" onclick="openCloneSvcModal('${esc(s.host_name)}','${esc(s.service_description)}')">Clone</button>
              <button class="btn btn-sm danger" onclick="deleteManagedSvc('${esc(s.host_name)}','${esc(s.service_description)}')">Delete</button>
            </td></tr>`).join('') : '<tr><td colspan="6" class="empty">No managed services yet.</td></tr>'}
        </tbody></table></div>
      </div>`;
  } else if (S.manageTab === 'commands') {
    const sData = await (await fetch('/api/v1/scripts')).json();
    const scripts = sData.scripts || [];
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Managed Commands (${c.commands.length})</div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm" onclick="quickRegisterNCPA()">+ NCPA Command</button>
            <button class="btn btn-sm primary" onclick="openCmdForm(-1)">+ Add Command</button>
          </div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Command Line</th><th style="text-align:right">Actions</th></tr></thead><tbody>
          ${c.commands.length ? c.commands.map((cmd, i) => `<tr><td><b>${esc(cmd.command_name)}</b></td><td class="mono">${esc(cmd.command_line)}</td>
            <td class="actions"><button class="btn btn-sm" onclick="openCmdForm(${i})">Edit</button><button class="btn btn-sm" onclick="openCmdForm(${i},true)">Clone</button><button class="btn btn-sm danger" onclick="deleteManagedItem('commands','name=${encodeURIComponent(cmd.command_name)}')">Delete</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty">No managed commands.</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Custom Scripts (${scripts.length})</div>
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
  } else if (S.manageTab === 'groups') {
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Hostgroups</div><button class="btn btn-sm primary" onclick="openGroupForm('hostgroups')">+ Hostgroup</button></div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Alias</th><th style="text-align:right">Actions</th></tr></thead><tbody>
          ${c.hostgroups.length ? c.hostgroups.map(g => `<tr><td><b>${esc(g.group_name)}</b></td><td>${esc(g.alias)}</td><td class="actions"><button class="btn btn-sm danger" onclick="deleteManagedItem('hostgroups','name=${encodeURIComponent(g.group_name)}')">Delete</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty">None</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Servicegroups</div><button class="btn btn-sm primary" onclick="openGroupForm('servicegroups')">+ Servicegroup</button></div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Alias</th><th style="text-align:right">Actions</th></tr></thead><tbody>
          ${c.servicegroups.length ? c.servicegroups.map(g => `<tr><td><b>${esc(g.group_name)}</b></td><td>${esc(g.alias)}</td><td class="actions"><button class="btn btn-sm danger" onclick="deleteManagedItem('servicegroups','name=${encodeURIComponent(g.group_name)}')">Delete</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty">None</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">Contacts</div><button class="btn btn-sm primary" onclick="openContactForm()">+ Contact</button></div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Alias</th><th>Email</th><th style="text-align:right">Actions</th></tr></thead><tbody>
          ${c.contacts.length ? c.contacts.map(ct => `<tr><td><b>${esc(ct.contact_name)}</b></td><td>${esc(ct.alias)}</td><td class="mono">${esc(ct.email)}</td><td class="actions"><button class="btn btn-sm danger" onclick="deleteManagedItem('contacts','name=${encodeURIComponent(ct.contact_name)}')">Delete</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">None</td></tr>'}
        </tbody></table></div>
      </div>`;
  }
}

async function renderLocalhostTab(el) {
  const data = await (await fetch('/api/v1/config/localhost')).json();
  if (!data.configured || !data.exists) {
    el.innerHTML = `<div class="panel"><div class="empty">File <code class="code-chip">${esc(data.path || 'localhost.cfg')}</code> not found.</div></div>`;
    return;
  }
  const canAdopt = !data.adopted && (data.parsed_hosts.length || data.parsed_services.length);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">${esc(data.path)} ${data.adopted ? '<span class="badge c-ok">ADOPTED</span>' : '<span class="badge c-warn">STANDALONE</span>'}</div>
        <div style="display:flex;gap:8px">
          ${canAdopt ? '<button class="btn btn-sm primary" onclick="adoptLocalhost()">1-Click Adopt</button>' : ''}
          <button class="btn btn-sm" onclick="saveLocalhostRaw()">Save Raw & Reload</button>
        </div>
      </div>
      <div style="padding:16px">
        ${data.parsed_services.length ? `<div class="table-wrap" style="margin-bottom:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <table><thead><tr><th>Host</th><th>Service</th><th>Command</th></tr></thead><tbody>
          ${data.parsed_services.map(s => `<tr><td><b>${esc(s.host_name)}</b></td><td>${esc(s.service_description)}</td><td class="mono">${esc(s.check_command)}</td></tr>`).join('')}
          </tbody></table></div>` : ''}
        <textarea id="lh-raw-editor" class="raw-editor">${esc(data.raw)}</textarea>
      </div>
    </div>`;
}

async function adoptLocalhost() {
  if (!confirm('Adopt localhost.cfg into Encore Managed Config? Original file will be backed up.')) return;
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
  const con = document.getElementById('validate-console');
  con.style.display = 'block'; con.textContent = 'Validating localhost.cfg...';
  const res = await fetch('/api/v1/config/localhost', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({raw: ta.value}) });
  const d = await res.json();
  con.textContent = (d.error ? 'ERROR: ' + d.error + '\n\n' : 'SAVED & RELOADING\n\n') + (d.output || '');
  toast(res.ok ? 'Saved & reloaded!' : ('Failed: ' + d.error));
}

async function renderSecretsTab(el) {
  const data = await (await fetch('/api/v1/secrets')).json();
  const list = data.secrets || [];
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">Resource Secrets (<code class="code-chip">$USER2$..$USER32$</code>)</div>
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
    <div class="form-row"><label>Macro Key ($USER2$ .. $USER32$)</label><input id="sec-key" type="text" value="${esc(key || '$USER2$')}" ${key?'readonly':''}></div>
    <div class="form-row"><label>Secret Value (e.g. NCPA Token)</label><input id="sec-val" type="password" placeholder="Enter secret token..."></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveSecretModal()">Save & Reload</button></div>`);
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
  if (!confirm(`Delete secret macro ${key}?`)) return;
  const res = await fetch('/api/v1/secrets?key=' + encodeURIComponent(key), { method:'DELETE' });
  if (res.ok) { toast('Deleted & reloading'); loadManage(); }
}

/* System Tabs */
function setSysTab(t) {
  S.sysTab = t;
  ['controls','backups','audit'].forEach(k => document.getElementById('stab-'+k)?.classList.toggle('active', k===t));
  loadSystem();
}
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

/* CRUD, Clone & Scripts Modals */
function openHostForm(idx) {
  const h = idx>=0 ? S.managed.config.hosts[idx] : { name:'', alias:'', address:'', check_command:'check-host-alive', check_interval:5, retry_interval:1, max_check_attempts:3, check_period:'24x7', contacts:'', hostgroups:[], enabled:true };
  openModal(`<h2>${idx>=0?'Edit Host':'Add Host'}</h2>
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
    <label class="chk-pill"><input type="checkbox" id="f-h-en" ${h.enabled!==false?'checked':''}> Enabled</label>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveHostForm()">Save</button></div>`);
}
async function saveHostForm() {
  await apiPost('/api/v1/config/hosts', {
    name: document.getElementById('f-h-name').value.trim(), address: document.getElementById('f-h-addr').value.trim(),
    alias: document.getElementById('f-h-alias').value.trim(), check_command: document.getElementById('f-h-cmd').value.trim(),
    hostgroups: document.getElementById('f-h-hg').value.split(',').map(x=>x.trim()).filter(Boolean),
    contacts: document.getElementById('f-h-ct').value.trim(),
    check_interval: Number(document.getElementById('f-h-int').value)||5, retry_interval: 1,
    max_check_attempts: Number(document.getElementById('f-h-att').value)||3, check_period: '24x7',
    enabled: document.getElementById('f-h-en').checked
  }, 'Host saved');
}
function openCloneHostModal(srcName) {
  openModal(`<h2>Clone Host: ${esc(srcName)}</h2>
    <div class="form-row"><label>New Host Name *</label><input id="c-h-name" type="text" placeholder="${esc(srcName)}-clone"></div>
    <div class="form-row"><label>New IP / Address *</label><input id="c-h-addr" type="text" placeholder="10.0.0.x"></div>
    <div class="form-row"><label>New Alias</label><input id="c-h-alias" type="text"></div>
    <label class="chk-pill"><input type="checkbox" id="c-h-svcs" checked> Clone all services of ${esc(srcName)}</label>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="submitCloneHost('${esc(srcName)}')">Clone</button></div>`);
}
async function submitCloneHost(srcName) {
  await apiPost('/api/v1/config/hosts/clone', {
    source_name: srcName, new_name: document.getElementById('c-h-name').value.trim(),
    new_address: document.getElementById('c-h-addr').value.trim(), new_alias: document.getElementById('c-h-alias').value.trim(),
    include_services: document.getElementById('c-h-svcs').checked
  }, 'Host cloned');
}
function openSvcForm(idx) {
  const s = idx>=0 ? S.managed.config.services[idx] : { host_name:'', service_description:'', check_command:'check_http', check_interval:5, retry_interval:1, max_check_attempts:3, check_period:'24x7', contacts:'', servicegroups:[], enabled:true };
  const hostOpts = S.managed.config.hosts.map(h => `<option value="${esc(h.name)}">`).join('');
  openModal(`<h2>${idx>=0?'Edit Service':'Add Service'}</h2>
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
      <div class="form-row full"><label>Check Command *</label><input id="f-s-cmd" type="text" value="${esc(s.check_command)}"></div>
      <div class="form-row"><label>Servicegroups</label><input id="f-s-sg" type="text" value="${esc((s.servicegroups||[]).join(','))}"></div>
      <div class="form-row"><label>Contacts</label><input id="f-s-ct" type="text" value="${esc(s.contacts)}"></div>
      <div class="form-row"><label>Interval (min)</label><input id="f-s-int" type="number" value="${s.check_interval||5}"></div>
      <div class="form-row"><label>Max Attempts</label><input id="f-s-att" type="number" value="${s.max_check_attempts||3}"></div>
    </div>
    <label class="chk-pill"><input type="checkbox" id="f-s-en" ${s.enabled!==false?'checked':''}> Enabled</label>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveSvcForm()">Save</button></div>`);
}
function applySvcPreset(desc, cmd) {
  if (!document.getElementById('f-s-desc').value) document.getElementById('f-s-desc').value = desc;
  document.getElementById('f-s-cmd').value = cmd;
}
async function saveSvcForm() {
  await apiPost('/api/v1/config/services', {
    host_name: document.getElementById('f-s-host').value.trim(), service_description: document.getElementById('f-s-desc').value.trim(),
    check_command: document.getElementById('f-s-cmd').value.trim(),
    servicegroups: document.getElementById('f-s-sg').value.split(',').map(x=>x.trim()).filter(Boolean),
    contacts: document.getElementById('f-s-ct').value.trim(),
    check_interval: Number(document.getElementById('f-s-int').value)||5, retry_interval: 1,
    max_check_attempts: Number(document.getElementById('f-s-att').value)||3, check_period: '24x7',
    enabled: document.getElementById('f-s-en').checked
  }, 'Service saved');
}
function openCloneSvcModal(srcHost, srcDesc) {
  openModal(`<h2>Clone Service: ${esc(srcHost)} / ${esc(srcDesc)}</h2>
    <div class="form-row"><label>Target Host *</label><input id="c-s-host" type="text" value="${esc(srcHost)}"></div>
    <div class="form-row"><label>New Description *</label><input id="c-s-desc" type="text" value="${esc(srcDesc)}-copy"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/services/clone',{source_host:'${esc(srcHost)}',source_description:'${esc(srcDesc)}',target_host:document.getElementById('c-s-host').value.trim(),target_description:document.getElementById('c-s-desc').value.trim()},'Service cloned')">Clone</button></div>`);
}
function openCmdForm(idx, isClone) {
  const c = idx>=0 ? S.managed.config.commands[idx] : { command_name:'', command_line:'$USER1$/check_http -H $HOSTADDRESS$' };
  openModal(`<h2>${isClone?'Clone Command':(idx>=0?'Edit Command':'Add Command')}</h2>
    <div class="form-row"><label>Name *</label><input id="f-c-name" type="text" value="${esc(isClone?c.command_name+'_copy':c.command_name)}"></div>
    <div class="form-row"><label>Command Line *</label><input id="f-c-line" type="text" value="${esc(c.command_line)}"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/commands',{command_name:document.getElementById('f-c-name').value.trim(),command_line:document.getElementById('f-c-line').value.trim()},'Command saved')">Save</button></div>`);
}
function openGroupForm(kind) {
  openModal(`<h2>Add ${kind==='hostgroups'?'Hostgroup':'Servicegroup'}</h2>
    <div class="form-row"><label>Name *</label><input id="f-g-name" type="text"></div>
    <div class="form-row"><label>Alias</label><input id="f-g-alias" type="text"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/${kind}',{group_name:document.getElementById('f-g-name').value.trim(),alias:document.getElementById('f-g-alias').value.trim()},'Group saved')">Save</button></div>`);
}
function openContactForm() {
  openModal(`<h2>Add Contact</h2>
    <div class="form-row"><label>Name *</label><input id="f-ct-name" type="text"></div>
    <div class="form-row"><label>Alias</label><input id="f-ct-alias" type="text"></div>
    <div class="form-row"><label>Email</label><input id="f-ct-email" type="text"></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/contacts',{contact_name:document.getElementById('f-ct-name').value.trim(),alias:document.getElementById('f-ct-alias').value.trim(),email:document.getElementById('f-ct-email').value.trim()},'Contact saved')">Save</button></div>`);
}
async function openScriptModal(name, kind) {
  let content = '';
  if (name) {
    content = (await (await fetch('/api/v1/scripts/content?name=' + encodeURIComponent(name))).json()).content || '';
  } else if (kind === 'python') {
    content = `#!/usr/bin/env python3\nimport sys\nhost = sys.argv[1] if len(sys.argv) > 1 else "localhost"\nprint(f"OK - python check {host} | val=1;5;10")\nsys.exit(0)\n`;
  } else {
    content = `#!/bin/sh\nHOST="\${1:-localhost}"\necho "OK - check \$HOST | latency=1.2ms;50;100"\nexit 0\n`;
  }
  openModal(`<h2>${name?'Edit '+esc(name):'New Script'}</h2>
    <div class="form-row"><label>Filename</label><input id="sc-name" type="text" value="${esc(name||(kind==='python'?'check_custom.py':'check_custom.sh'))}" ${name?'readonly':''}></div>
    <div class="form-row"><label>Content (auto chmod +x)</label><textarea id="sc-body" class="raw-editor">${esc(content)}</textarea></div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="saveScriptModal()">Save</button></div>`);
}
async function saveScriptModal() {
  const res = await fetch('/api/v1/scripts', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:document.getElementById('sc-name').value.trim(), content:document.getElementById('sc-body').value}) });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  closeModal(); toast('Script saved'); loadManage();
}
async function deleteScript(name) {
  if (confirm(`Delete script "${name}"?`) && (await fetch('/api/v1/scripts?name='+encodeURIComponent(name), {method:'DELETE'})).ok) { toast('Deleted'); loadManage(); }
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
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="apiPost('/api/v1/config/commands',{command_name:document.getElementById('f-c-name').value.trim(),command_line:document.getElementById('f-c-line').value.trim()},'Command registered')">Register</button></div>`);
}
async function quickRegisterNCPA() {
  await apiPost('/api/v1/config/commands', {
    command_name: 'check_ncpa',
    command_line: "$USER1$/check_ncpa.py -H $HOSTADDRESS$ -t '$USER2$' -P 5693 -M $ARG1$ $ARG2$"
  }, 'check_ncpa registered using $USER2$');
}

async function apiPost(url, payload, okMsg) {
  try {
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    closeModal(); toast(okMsg + ' — click Apply & Reload');
    if (S.view === 'manage') await loadManage();
    await loadMeta();
  } catch (e) { toast('Error: ' + e.message); }
}
async function deleteManagedHost(name) { if (confirm(`Delete host "${name}"?`)) await deleteManagedItem('hosts', 'name='+encodeURIComponent(name)); }
async function deleteManagedSvc(host, desc) { if (confirm(`Delete "${host}/${desc}"?`)) await deleteManagedItem('services', `host=${encodeURIComponent(host)}&description=${encodeURIComponent(desc)}`); }
async function deleteManagedItem(kind, qs) {
  const res = await fetch(`/api/v1/config/${kind}?${qs}`, { method:'DELETE' });
  if (!res.ok) { toast('Delete failed'); return; }
  toast('Deleted — click Apply & Reload'); await loadManage(); await loadMeta();
}
async function runValidate(apply) {
  const con = document.getElementById('validate-console');
  if (con) { con.style.display = 'block'; con.textContent = apply ? 'Applying...' : 'Validating...'; }
  const res = await fetch(apply ? '/api/v1/config/apply' : '/api/v1/config/validate', { method:'POST' });
  const d = await res.json();
  if (con) con.textContent = (d.error ? 'ERROR: '+d.error+'\n\n' : 'OK\n\n') + (d.output||'');
  toast(res.ok ? (apply ? 'Applied & reloading!' : 'Valid!') : 'Validation failed');
  if (res.ok && apply) { if (S.view === 'manage') await loadManage(); setTimeout(refreshAll, 1400); }
}
async function rollbackBackup(name) {
  if (!confirm(`Rollback to ${name}?`)) return;
  const res = await fetch('/api/v1/config/rollback', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({backup:name}) });
  toast(res.ok ? 'Rolled back & reloading!' : 'Rollback failed');
  if (res.ok) { await loadSystem(); setTimeout(refreshAll, 1400); }
}
