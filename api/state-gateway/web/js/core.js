const S = {
  view: 'overview',
  invTab: 'services',
  probTab: 'active',
  manageTab: 'objects',
  sysTab: 'controls',
  guideTab: 'quick',
  ncpaOS: 'ubuntu',
  ovMapMode: 'grid',
  offset: 0,
  total: 0,
  autoMs: 3000,
  timer: null,
  groupByHost: false,
  summary: null,
  hostgroups: [],
  servicegroups: [],
  managed: { enabled: false, pending_changes: false, config: { hosts:[], services:[], commands:[], contacts:[], hostgroups:[], servicegroups:[], templates:[] }, diff: { pending:false, total:0, entries:[] } },
  lastItems: [],
  catalogCmds: [],
  invFilter: { state: '', unhandled: false, sort: 'severity' },
  probFilter: { state: '', unhandled: false, sort: 'severity' },
  selectedMon: new Set(),
  selectedManagedHosts: new Set(),
  selectedManagedSvcs: new Set(),
  manageSearch: '',
  manageGroup: '',
  manageStatus: '',
  manageFlat: false,
  expandedHosts: new Set(),
  localhostStatus: null,
  repTab: 'sla',
  repRange: '24h',
  repGroupByHost: true,
  repExpandedHosts: new Set(),
  ovTrendCache: { ts: 0, data: null }
};

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('theme-btn').textContent = t === 'dark' ? 'Light' : 'Dark';
  localStorage.setItem('encore-theme', t);
}
applyTheme(localStorage.getItem('encore-theme') || 'light');
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  sb.classList.toggle('collapsed');
  const btn = document.getElementById('sb-toggle-btn');
  if (btn) btn.textContent = sb.classList.contains('collapsed') ? '»' : '«';
}
function openMobileSidebar() {
  document.getElementById('sidebar').classList.add('mobile-open');
  document.getElementById('sb-backdrop').classList.add('open');
}
function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sb-backdrop').classList.remove('open');
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openQuickJump();
    return;
  }
  if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    document.getElementById('global-search').focus();
  } else if (e.key === 'Escape') {
    if (document.getElementById('confirm-backdrop')?.classList.contains('open')) resolveConfirm(false);
    else { closeDrawer(); closeModal(); closeQuickJump(); closeMobileSidebar(); }
  }
});

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}
function copyText(txt) {
  navigator.clipboard?.writeText(txt).then(() => toast('Copied to clipboard')).catch(() => toast(txt));
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

/* Modern Smooth Confirmation Dialog (replaces native browser confirm()) */
let _confirmResolver = null;
function encoreConfirm({ title, message, items = [], confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    _confirmResolver = resolve;
    const iconSVG = danger
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>`;
    const itemsHTML = items.length ? `<div class="confirm-items">${items.slice(0, 18).map(it => `<span class="flag-tag">${esc(it)}</span>`).join('')}${items.length > 18 ? `<span class="flag-tag">+${items.length - 18} more</span>` : ''}</div>` : '';
    document.getElementById('confirm-content').innerHTML = `
      <div class="confirm-head">
        <div class="confirm-icon ${danger?'danger':''}">${iconSVG}</div>
        <div>
          <h2 style="margin-bottom:4px">${esc(title)}</h2>
          <p style="font-size:13px;color:var(--muted)">${esc(message)}</p>
        </div>
      </div>
      ${itemsHTML}
      <div class="modal-foot">
        <button class="btn" onclick="resolveConfirm(false)">${esc(cancelText)}</button>
        <button class="btn ${danger?'danger':'primary'}" id="confirm-ok-btn" onclick="resolveConfirm(true)">${esc(confirmText)}</button>
      </div>`;
    document.getElementById('confirm-backdrop').classList.add('open');
    setTimeout(() => document.getElementById('confirm-ok-btn')?.focus(), 40);
  });
}
function resolveConfirm(ok) {
  document.getElementById('confirm-backdrop').classList.remove('open');
  if (_confirmResolver) {
    const fn = _confirmResolver;
    _confirmResolver = null;
    fn(ok);
  }
}

/* Lightweight Inline SVG Art Helpers (themed via CSS variables) */
function artSVG(kind) {
  if (kind === 'radar-ok') {
    return `<svg width="74" height="74" viewBox="0 0 80 80" fill="none">
      <circle cx="40" cy="40" r="34" stroke="var(--ok)" stroke-opacity="0.18" stroke-width="2"/>
      <circle cx="40" cy="40" r="23" stroke="var(--ok)" stroke-opacity="0.32" stroke-width="2" stroke-dasharray="4 4"/>
      <circle cx="40" cy="40" r="13" fill="var(--ok-bg)" stroke="var(--ok)" stroke-width="2"/>
      <path d="M34 40.5l4 4 8.5-9" stroke="var(--ok)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (kind === 'servers') {
    return `<svg width="74" height="64" viewBox="0 0 80 68" fill="none">
      <rect x="12" y="10" width="56" height="18" rx="5" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="1.8"/>
      <circle cx="22" cy="19" r="3" fill="var(--ok)"/>
      <rect x="30" y="17" width="28" height="4" rx="2" fill="var(--border)"/>
      <rect x="12" y="34" width="56" height="18" rx="5" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1.8"/>
      <circle cx="22" cy="43" r="3" fill="var(--accent)"/>
      <rect x="30" y="41" width="22" height="4" rx="2" fill="var(--border)"/>
    </svg>`;
  }
  return `<svg width="68" height="62" viewBox="0 0 72 64" fill="none">
    <rect x="10" y="12" width="52" height="40" rx="8" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="1.8"/>
    <path d="M22 36l10-10 8 7 12-13" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function isUserInteracting() {
  if (document.getElementById('modal-backdrop')?.classList.contains('open')) return true;
  if (document.getElementById('confirm-backdrop')?.classList.contains('open')) return true;
  if (document.getElementById('drawer-wrap')?.classList.contains('open')) return true;
  if (document.getElementById('qj-backdrop')?.classList.contains('open')) return true;
  if (S.selectedMon.size > 0) return true;
  return false;
}

async function sendCmd(cmd, label) {
  try {
    const res = await fetch('/api/v1/command', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command: cmd}) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    toast(label + ' queued');
    setTimeout(refreshAll, 700);
  } catch (e) { toast('Error: ' + e.message); }
}

async function sendBatchCmds(commands, label) {
  try {
    const res = await fetch('/api/v1/commands/batch', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({commands}) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    toast(`${label}: ${d.count} queued`);
    S.selectedMon.clear();
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
  if (S.view === 'inventory' || S.view === 'problems') saveMonitorFilterState(S.view);
  S.view = v;
  S.offset = 0;
  S.selectedMon.clear();
  closeMobileSidebar();
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
    restoreMonitorFilterState('inventory');
    renderMonitorSubtabs();
    loadMonitorView();
  } else if (v === 'problems') {
    document.getElementById('sec-monitor').style.display = 'block';
    if (sub) S.probTab = sub;
    restoreMonitorFilterState('problems');
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
  if (S.autoMs > 0) {
    S.timer = setInterval(() => {
      if (!isUserInteracting()) refreshAll();
    }, S.autoMs);
  }
}

async function refreshAll() {
  try {
    await loadMeta();
    if (S.view === 'overview') await loadOverview();
    else if (S.view === 'inventory' || S.view === 'problems') await loadMonitorView();
  } catch (e) {
    const dot = document.getElementById('conn-dot');
    if (dot) dot.className = 'pulse-dot crit';
    document.getElementById('conn-label').textContent = 'Offline';
  }
}

/* Quick Jump Palette (Ctrl+K) */
let qjHostsCache = [];
async function openQuickJump() {
  document.getElementById('qj-backdrop').classList.add('open');
  const inp = document.getElementById('qj-input');
  inp.value = '';
  inp.focus();
  try {
    const res = await fetch('/api/v1/hosts?limit=200');
    qjHostsCache = (await res.json()).hosts || [];
  } catch (e) {}
  renderQuickJump();
}
function closeQuickJump() { document.getElementById('qj-backdrop').classList.remove('open'); }
function renderQuickJump() {
  const q = (document.getElementById('qj-input')?.value || '').trim().toLowerCase();
  const staticItems = [
    { label: 'Overview — Fleet Map & Charts', tag: 'Page', run: () => setView('overview') },
    { label: 'Inventory — Services', tag: 'Page', run: () => setView('inventory','services') },
    { label: 'Inventory — Hosts', tag: 'Page', run: () => setView('inventory','hosts') },
    { label: 'Active Problems', tag: 'Page', run: () => setView('problems','active') },
    { label: 'Historical Reports & SLA Charts', tag: 'Page', run: () => setView('reports','sla') },
    { label: 'Manage — Hosts & Services', tag: 'Config', run: () => setView('manage','objects') },
    { label: 'Manage — Service Templates', tag: 'Config', run: () => setView('manage','templates') },
    { label: 'Manage — Email & Webhook Notifications', tag: 'Config', run: () => setView('manage','notifications') },
    { label: 'Manage — Commands & Scripts', tag: 'Config', run: () => setView('manage','commands') },
    { label: 'Manage — Secrets ($USERn$)', tag: 'Config', run: () => setView('manage','secrets') },
    { label: 'Review Pending Config Diff', tag: 'Config', run: () => openDiffReviewModal() },
    { label: 'User Guide — Menus & Features', tag: 'Help', run: () => setView('guide','menus') },
    { label: 'User Guide — NCPA Quick Install', tag: 'Help', run: () => setView('guide','ncpa') },
    { label: 'Add New Host', tag: 'Action', run: () => { setView('manage','objects'); setTimeout(() => openHostForm(-1), 250); } },
    { label: 'Add New Service', tag: 'Action', run: () => { setView('manage','objects'); setTimeout(() => openSvcForm(-1), 250); } }
  ];
  const hostItems = qjHostsCache.map(h => ({
    label: `${h.name} (${h.address})`,
    tag: 'Host',
    run: () => {
      document.getElementById('global-search').value = h.name;
      setView('inventory', 'services');
    }
  }));
  const all = [...staticItems, ...hostItems].filter(it => !q || it.label.toLowerCase().includes(q) || it.tag.toLowerCase().includes(q)).slice(0, 14);
  window._qjActions = all;
  document.getElementById('qj-list').innerHTML = all.length ? all.map((it, i) => `
    <div class="qj-item" onclick="closeQuickJump();window._qjActions[${i}].run()">
      <span>${esc(it.label)}</span><span class="flag-tag">${esc(it.tag)}</span>
    </div>`).join('') : '<div class="empty" style="padding:18px">No matches</div>';
}
