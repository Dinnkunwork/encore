const S = {
  view: 'overview',
  invTab: 'services',
  probTab: 'active',
  manageTab: 'objects',
  sysTab: 'controls',
  guideTab: 'quick',
  offset: 0,
  total: 0,
  autoMs: 3000,
  timer: null,
  groupByHost: false,
  summary: null,
  hostgroups: [],
  servicegroups: [],
  managed: { enabled: false, pending_changes: false, config: { hosts:[], services:[], commands:[], contacts:[], hostgroups:[], servicegroups:[] } },
  lastItems: [],
  catalogCmds: []
};

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('theme-btn').textContent = t === 'dark' ? 'Light' : 'Dark';
  localStorage.setItem('encore-theme', t);
}
applyTheme(localStorage.getItem('encore-theme') || 'light');
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('collapsed'); }

document.addEventListener('keydown', e => {
  if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    document.getElementById('global-search').focus();
  } else if (e.key === 'Escape') { closeDrawer(); closeModal(); }
});

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}
function copyText(txt) {
  navigator.clipboard?.writeText(txt).then(() => toast('Copied: ' + txt)).catch(() => toast(txt));
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function relTime(ts) {
  if (!ts) return 'never';
  const d = Math.max(0, Math.floor(Date.now()/1000) - ts);
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d/60) + 'm ago';
  if (d < 86400) return Math.floor(d/3600) + 'h ago';
  return Math.floor(d/86400) + 'd ago';
}
function durStr(ts) {
  if (!ts) return '-';
  const d = Math.max(0, Math.floor(Date.now()/1000) - ts);
  const days = Math.floor(d/86400), hrs = Math.floor((d%86400)/3600), mins = Math.floor((d%3600)/60);
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m ${d%60}s`;
}
function hostBadge(h) {
  if (!h.has_been_checked) return '<span class="badge c-pend"><img src="/assets/status/status-offline.svg">PENDING</span>';
  const m = {0:['UP','c-ok','status-ok.svg'],1:['DOWN','c-crit','status-critical.svg'],2:['UNREACH','c-warn','status-warn.svg']};
  const [l,c,ic] = m[h.current_state] || ['UNK','c-unk','status-info.svg'];
  return `<span class="badge ${c}"><img src="/assets/status/${ic}">${l}</span>`;
}
function svcBadge(s) {
  if (!s.has_been_checked) return '<span class="badge c-pend"><img src="/assets/status/status-offline.svg">PENDING</span>';
  const m = {0:['OK','c-ok','status-ok.svg'],1:['WARN','c-warn','status-warn.svg'],2:['CRIT','c-crit','status-critical.svg'],3:['UNK','c-unk','status-info.svg']};
  const [l,c,ic] = m[s.current_state] || ['UNK','c-unk','status-info.svg'];
  return `<span class="badge ${c}"><img src="/assets/status/${ic}">${l}</span>`;
}
function flagsHTML(o) {
  let out = '';
  if (o.acknowledged) out += '<span class="flag-tag">ACK</span>';
  if (o.downtime_depth > 0) out += '<span class="flag-tag">DT</span>';
  if (o.is_flapping) out += '<span class="flag-tag">FLAP</span>';
  if (o.state_type === 0 && o.current_state > 0) out += '<span class="flag-tag">SOFT</span>';
  return out ? `<span class="flags">${out}</span>` : '';
}

function openModal(html) { document.getElementById('modal-content').innerHTML = html; document.getElementById('modal-backdrop').classList.add('open'); }
function closeModal() { document.getElementById('modal-backdrop').classList.remove('open'); }
function closeDrawer() { document.getElementById('drawer-wrap').classList.remove('open'); }

async function sendCmd(cmd, label) {
  try {
    const res = await fetch('/api/v1/command', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command: cmd}) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    toast(label + ' queued');
    setTimeout(refreshAll, 700);
  } catch (e) { toast('Error: ' + e.message); }
}

const VIEW_TITLES = {
  overview: 'Overview',
  inventory: 'Inventory',
  problems: 'Problems',
  reports: 'Historical Reports & SLA',
  manage: 'Manage Configuration',
  system: 'System',
  guide: 'User Guide'
};

function setView(v, sub) {
  S.view = v;
  S.offset = 0;
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('page-title').textContent = VIEW_TITLES[v] || v;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const activeNav = document.getElementById('nav-' + v);
  if (activeNav) activeNav.classList.add('active');

  ['sec-overview','sec-monitor','sec-reports','sec-manage','sec-system','sec-guide'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });

  if (v === 'overview') {
    document.getElementById('sec-overview').style.display = 'block';
    loadOverview();
  } else if (v === 'inventory') {
    document.getElementById('sec-monitor').style.display = 'block';
    if (sub) S.invTab = sub;
    renderMonitorSubtabs();
    loadMonitorView();
  } else if (v === 'problems') {
    document.getElementById('sec-monitor').style.display = 'block';
    if (sub) S.probTab = sub;
    renderMonitorSubtabs();
    loadMonitorView();
  } else if (v === 'reports') {
    document.getElementById('sec-reports').style.display = 'block';
    if (sub) S.repTab = sub;
    setReportTab(S.repTab);
  } else if (v === 'manage') {
    document.getElementById('sec-manage').style.display = 'block';
    if (sub) S.manageTab = sub;
    setManageTab(S.manageTab);
  } else if (v === 'system') {
    document.getElementById('sec-system').style.display = 'block';
    if (sub) S.sysTab = sub;
    setSysTab(S.sysTab);
  } else if (v === 'guide') {
    document.getElementById('sec-guide').style.display = 'block';
    if (sub) S.guideTab = sub;
    setGuideTab(S.guideTab);
  }
}

function setAutoInterval() {
  S.autoMs = Number(document.getElementById('auto-select').value);
  clearInterval(S.timer);
  if (S.autoMs > 0) S.timer = setInterval(refreshAll, S.autoMs);
}

async function refreshAll() {
  try {
    await loadMeta();
    if (S.view === 'overview') await loadOverview();
    else if (S.view === 'inventory' || S.view === 'problems') await loadMonitorView();
  } catch (e) {
    document.getElementById('conn-icon').src = '/assets/status/status-critical.svg';
    document.getElementById('conn-label').textContent = 'Offline';
  }
}
