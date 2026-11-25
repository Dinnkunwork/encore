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
  ovTrendCache: { ts: 0, data: null },
  me: { auth_enabled: false, user: { username: 'local-admin', display_name: 'Local Admin', role: 'admin' } },
  sseConnected: false,
  livePaused: false,
  alertSound: localStorage.getItem('encore-alert-sound') === '1',
  tvMode: false
};

function canOperate() { const r = S.me?.user?.role || 'admin'; return r === 'admin' || r === 'operator'; }
function isAdmin() { return (S.me?.user?.role || 'admin') === 'admin'; }

function applyTheme(t) {
  const valid = ['light','dark','cyber','nord','emerald'];
  if (!valid.includes(t)) t = 'light';
  document.documentElement.setAttribute('data-theme', t);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = t;
  localStorage.setItem('encore-theme', t);
}
applyTheme(localStorage.getItem('encore-theme') || 'light');

async function initAuthAndBoot() {
  try {
    const res = await fetch('/api/v1/auth/me');
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (res.ok) {
      S.me = await res.json();
      const chip = document.getElementById('user-chip');
      if (chip) {
        chip.style.display = 'inline-flex';
        document.getElementById('user-chip-name').textContent = S.me.user.username;
        document.getElementById('user-chip-role').textContent = (S.me.user.role || 'admin').toUpperCase();
      }
      // Apply RBAC menu visibility
      if (!isAdmin()) {
        document.getElementById('nav-manage')?.style.setProperty('display', 'none');
        document.getElementById('nav-system')?.style.setProperty('display', 'none');
      }
    }
  } catch (e) {}
  refreshAll();
  setAutoInterval();
  connectSSE();
  updateAlertSoundBtn();
}

/* Real-time SSE Push Client + Optional Web Audio Chime & Desktop Notification */
let _sseSource = null;
let _sseRefreshTimer = null;
function connectSSE() {
  if (typeof EventSource === 'undefined') return;
  if (_sseSource) { try { _sseSource.close(); } catch (e) {} }
  const es = new EventSource('/api/v1/stream');
  _sseSource = es;
  es.addEventListener('ready', () => {
    S.sseConnected = true;
    const lbl = document.getElementById('conn-label');
    if (lbl) lbl.textContent = 'Live (SSE)';
    setAutoInterval(); // Slow fallback polling to 30s when SSE is active
  });
  es.addEventListener('state', e => {
    try {
      const ev = JSON.parse(e.data);
      // Optional sound & desktop notification on new HARD CRITICAL/DOWN
      if (S.alertSound && ev.state_type === 1 && ev.state > 0 && ev.prev_state !== ev.state) {
        playAlertChime();
        if ('Notification' in window && Notification.permission === 'granted') {
          const target = ev.service ? `${ev.host} / ${ev.service}` : ev.host;
          new Notification(`Encore Alert: ${target}`, { body: ev.output || 'State changed to problem' });
        }
      }
    } catch (err) {}
    if (!S.livePaused && !isUserInteracting() && !_sseRefreshTimer) {
      _sseRefreshTimer = setTimeout(() => {
        _sseRefreshTimer = null;
        refreshAll();
      }, 280);
    }
  });
  es.onerror = () => {
    S.sseConnected = false;
    setAutoInterval();
  };
}

function updateAlertSoundBtn() {
  const b = document.getElementById('alert-sound-btn');
  if (!b) return;
  b.textContent = S.alertSound ? '🔔 On' : '🔔 Off';
  b.classList.toggle('active', S.alertSound);
}
function toggleAlertSound() {
  S.alertSound = !S.alertSound;
  localStorage.setItem('encore-alert-sound', S.alertSound ? '1' : '0');
  updateAlertSoundBtn();
  if (S.alertSound) {
    playAlertChime();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    toast('Real-time HARD alert sound enabled');
  } else {
    toast('Alert sound muted');
  }
}
function playAlertChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.16);
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.28);
  } catch (e) {}
}

/* NOC Wallboard / TV Mode */
function toggleTVMode() {
  S.tvMode = !S.tvMode;
  document.body.classList.toggle('tv-mode', S.tvMode);
  if (S.tvMode) {
    setView('overview');
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    toast('NOC TV Mode active — press Esc to exit');
  } else if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function openAccountModal() {
  const u = S.me.user || {};
  openModal(`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <encore-icon name="user" size="3" live></encore-icon>
      <div>
        <h2 style="margin:0">${esc(u.display_name || u.username)}</h2>
        <div class="name-sub">@${esc(u.username)} • Role: <b>${esc((u.role||'admin').toUpperCase())}</b></div>
      </div>
    </div>
    ${S.me.auth_enabled ? `
      <div class="form-row"><label>Current Password</label><input id="pw-cur" type="password"></div>
      <div class="form-row"><label>New Password (min 4 chars)</label><input id="pw-new" type="password"></div>
      <div class="modal-foot">
        <button class="btn danger" onclick="doLogout()">Sign Out</button>
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn primary" onclick="submitChangePassword()">Change Password</button>
      </div>
    ` : `
      <p class="name-sub" style="margin-bottom:12px">Multi-user login belum diaktifkan. Tambahkan flag <code class="code-chip">-auth-user admin -auth-pass PASSWORD</code> pada service gateway atau buat user pertama di <b>Manage → Users</b>.</p>
      <div class="modal-foot">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn primary" onclick="closeModal();setView('manage','users')">Manage Users ›</button>
      </div>
    `}`);
}
async function submitChangePassword() {
  const res = await fetch('/api/v1/auth/password', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ current_password: document.getElementById('pw-cur').value, new_password: document.getElementById('pw-new').value })
  });
  const d = await res.json();
  if (!res.ok) { toast('Error: ' + d.error); return; }
  closeModal(); toast('Password updated!');
}
async function doLogout() {
  await fetch('/api/v1/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}
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
  if (e.shiftKey && e.key.toLowerCase() === 't' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    toggleTVMode();
    return;
  }
  if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    document.getElementById('global-search').focus();
  } else if (e.key === 'Escape') {
    if (S.tvMode) { toggleTVMode(); return; }
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
function jsEsc(s) { return esc(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r|\n/g, ' ')); }
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
  return fmtDurationSec(Math.max(0, Math.floor(Date.now()/1000) - ts));
}
function fmtDurationSec(sec) {
  const d = Math.max(0, Math.round(Number(sec) || 0));
  if (d === 0) return '0s';
  const days = Math.floor(d/86400), hrs = Math.floor((d%86400)/3600), mins = Math.floor((d%3600)/60), secs = d%60;
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
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

/* Crisp Pixelated Mascot Art Helpers (from encore-art-templates) */
function artSVG(kind) {
  const map = {
    'radar-ok': '/assets/mascots/bot-ok.svg',
    'servers': '/assets/mascots/bot-empty.svg',
    'search': '/assets/mascots/bot-search.svg',
    '403': '/assets/mascots/bot-403.svg',
    '503': '/assets/mascots/bot-503.svg'
  };
  const src = map[kind] || '/assets/mascots/bot-empty.svg';
  return `<img src="${src}" alt="" class="pixel-art" style="width:76px;height:76px;display:block;margin:0 auto 10px">`;
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

function toggleLiveUpdates() {
  S.livePaused = !S.livePaused;
  updateLiveToggleBtn();
  setAutoInterval();
  toast(S.livePaused ? 'Live updates paused' : 'Live updates resumed');
}
function updateLiveToggleBtn() {
  const b = document.getElementById('live-toggle-btn');
  if (!b) return;
  if (S.livePaused) {
    b.textContent = '⏸ Paused';
    b.classList.remove('active');
    b.title = 'Live updates paused — click to resume';
  } else {
    b.textContent = S.sseConnected ? '● Live' : '● Sync';
    b.classList.add('active');
    b.title = S.sseConnected ? 'Real-time SSE push active (click to pause)' : 'Fallback 5s sync active (click to pause)';
  }
}
function setAutoInterval() {
  updateLiveToggleBtn();
  clearInterval(S.timer);
  if (S.livePaused) { S.autoMs = 0; return; }
  // When SSE real-time push is connected, only do a 30s safety resync; if SSE drops, poll every 5s
  S.autoMs = S.sseConnected ? 30000 : 5000;
  S.timer = setInterval(() => {
    if (!S.livePaused && !isUserInteracting()) refreshAll();
  }, S.autoMs);
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
