const S = {
  view: 'overview',
  invTab: 'byhost',
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
  invExpandedHosts: new Set(),
  invCollapsedHosts: new Set(),
  invExpandInit: false,
  invLastGroups: [],
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
  lastGoodSync: 0,
  alertSound: localStorage.getItem('encore-alert-sound') === '1',
  tvMode: false
};

/* Unified 16px Stroke SVG Icon System (replaces OS emojis & Unicode glyphs) */
const UI_ICON_PATHS = {
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  shield: '<path d="M12 3 5 6v6c0 5 3.5 8 7 9 3.5-1 7-4 7-9V6l-7-3Z"/>'
};
function uiIcon(name, cls = 'sm') {
  const p = UI_ICON_PATHS[name] || UI_ICON_PATHS.info;
  return `<svg class="ui-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

function canOperate() { const r = S.me?.user?.role || 'admin'; return r === 'admin' || r === 'operator'; }
function isAdmin() { return (S.me?.user?.role || 'admin') === 'admin'; }

/* Safe JSON fetch helper with explicit status checking */
async function apiFetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function setConnectionBanner(offline, detail) {
  const el = document.getElementById('conn-banner');
  const txt = document.getElementById('conn-banner-text');
  if (!el) return;
  if (!offline) {
    el.classList.remove('show');
    return;
  }
  const since = S.lastGoodSync ? ` Last valid snapshot: ${new Date(S.lastGoodSync).toLocaleTimeString()}.` : '';
  if (txt) txt.textContent = (detail || 'Connection to Encore State Gateway lost — displayed data may be stale.') + since;
  el.classList.add('show');
}

function applyTheme(t) {
  const valid = ['light','dark','cyber','nord','emerald'];
  if (!valid.includes(t)) t = 'light';
  document.documentElement.setAttribute('data-theme', t);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = t;
  localStorage.setItem('encore-theme', t);
}
applyTheme(localStorage.getItem('encore-theme') || 'light');

/* Display Preferences Popover */
function toggleDisplayMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('display-menu');
  const btn = document.getElementById('display-menu-btn');
  if (!menu || !btn) return;
  const open = !menu.classList.contains('open');
  if (open) {
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
    menu.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  } else {
    closeDisplayMenu();
  }
}
function closeDisplayMenu() {
  closeActiveDropdown();
  const menu = document.getElementById('display-menu');
  const btn = document.getElementById('display-menu-btn');
  if (menu) menu.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', e => {
  const menu = document.getElementById('display-menu');
  const btn = document.getElementById('display-menu-btn');
  const ddPortal = document.getElementById('ec-dd-portal');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target) && (!btn || !btn.contains(e.target)) && (!ddPortal || !ddPortal.contains(e.target))) {
    closeDisplayMenu();
  }
});

/* URL Hash Routing (Supports Browser Back/Forward & Refresh) */
function syncHashFromState() {
  const subMap = { inventory: S.invTab, problems: S.probTab, reports: S.repTab, manage: S.manageTab, system: S.sysTab, guide: S.guideTab };
  const sub = subMap[S.view];
  const nextHash = sub ? `#${S.view}/${sub}` : `#${S.view}`;
  if (window.location.hash !== nextHash) {
    history.pushState(null, '', nextHash);
  }
}
function applyRouteFromHash() {
  const raw = (window.location.hash || '').replace(/^#/, '');
  if (!raw) return false;
  const [v, sub] = raw.split('/');
  const validViews = ['overview','inventory','problems','reports','manage','system','guide'];
  if (!validViews.includes(v)) return false;
  if ((v === 'manage' || v === 'system') && !isAdmin()) return false;
  setView(v, sub || undefined, true);
  return true;
}
window.addEventListener('hashchange', () => applyRouteFromHash());

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
      if (!isAdmin()) {
        document.getElementById('nav-manage')?.style.setProperty('display', 'none');
        document.getElementById('nav-system')?.style.setProperty('display', 'none');
        document.getElementById('ov-audit-panel')?.style.setProperty('display', 'none');
      }
    }
  } catch (e) {}
  const routed = applyRouteFromHash();
  await refreshAll();
  if (!routed && S.view === 'overview') syncHashFromState();
  setAutoInterval();
  connectSSE();
  updateAlertSoundBtn();
  initTelemetryRibbon();
}

/* ==========================================================================
   LIVE SSE OSCILLOSCOPE RIBBON (60fps Canvas Pulse + Live Event Ticker + Clock)
   ========================================================================== */
const _waveBuf = new Array(58).fill(0);
let _waveAccent = '#0e835a';
function pushTelemetryPulse(state, text) {
  const amp = state >= 2 ? 1.0 : (state === 1 ? 0.72 : 0.45);
  _waveBuf.push(amp, -amp * 0.55);
  while (_waveBuf.length > 58) _waveBuf.shift();
  const cs = getComputedStyle(document.documentElement);
  _waveAccent = state >= 2 ? cs.getPropertyValue('--crit').trim() : (state === 1 ? cs.getPropertyValue('--warn').trim() : cs.getPropertyValue('--ok').trim());
  const ticker = document.getElementById('tr-ticker');
  if (ticker && text) {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    ticker.innerHTML = `<span class="tr-tag">${esc(t)}</span>${esc(text)}`;
  }
}
function initTelemetryRibbon() {
  const clockEl = document.getElementById('tr-clock');
  const tickClock = () => { if (clockEl) clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false }); };
  tickClock();
  setInterval(tickClock, 1000);

  const canvas = document.getElementById('sse-wave-canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  function draw() {
    if (!document.hidden) {
      frame++;
      if (frame % 4 === 0) {
        // Decay tail gently toward quiet instrument baseline
        _waveBuf.push((Math.sin(frame * 0.08) * 0.04));
        if (_waveBuf.length > 58) _waveBuf.shift();
      }
      const w = canvas.width, h = canvas.height, mid = h / 2;
      ctx.clearRect(0, 0, w, h);
      const borderCol = getComputedStyle(document.documentElement).getPropertyValue('--border-strong').trim() || '#b8b3a6';
      ctx.strokeStyle = borderCol;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

      ctx.strokeStyle = _waveAccent || '#0e835a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const step = w / (_waveBuf.length - 1);
      for (let i = 0; i < _waveBuf.length; i++) {
        const x = i * step;
        const y = mid - _waveBuf[i] * (mid - 4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
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
    setConnectionBanner(false);
    setAutoInterval();
  });
  es.addEventListener('state', e => {
    try {
      const ev = JSON.parse(e.data);
      const target = ev.service ? `${ev.host} / ${ev.service}` : ev.host;
      const stLabels = ev.service ? ['OK','WARN','CRIT','UNK'] : ['UP','DOWN','UNREACH','UNK'];
      pushTelemetryPulse(ev.state, `${target} → ${stLabels[ev.state] || ev.state}${ev.output ? ' · ' + ev.output.slice(0, 68) : ''}`);
      if (S.alertSound && ev.state_type === 1 && ev.state > 0 && ev.prev_state !== ev.state) {
        playAlertChime();
        if ('Notification' in window && Notification.permission === 'granted') {
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
  b.textContent = S.alertSound ? 'On' : 'Off';
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
      <div class="acct-avatar" aria-hidden="true">
        <svg class="ui-ico lg" viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4" fill="currentColor" fill-opacity="0.16"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>
      </div>
      <div>
        <h2 style="margin:0">${esc(u.display_name || u.username)}</h2>
        <div class="name-sub">@${esc(u.username)} · Role: <b>${esc((u.role||'admin').toUpperCase())}</b></div>
      </div>
    </div>
    ${S.me.auth_enabled ? `
      <div class="form-row"><label for="pw-cur">Current Password</label><input id="pw-cur" type="password"></div>
      <div class="form-row"><label for="pw-new">New Password (min 4 chars)</label><input id="pw-new" type="password"></div>
      <div class="modal-foot">
        <button class="btn danger" onclick="doLogout()">Sign Out</button>
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn primary" onclick="submitChangePassword()">Change Password</button>
      </div>
    ` : `
      <p class="name-sub" style="margin-bottom:12px">Multi-user login is not enabled. Start the gateway with <code class="code-chip">-auth-user admin -auth-pass PASSWORD</code> or create the first user under <b>Manage → Users</b>.</p>
      <div class="modal-foot">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn primary" onclick="closeModal();setView('manage','users')">Manage Users</button>
      </div>
    `}`);
}
async function submitChangePassword() {
  try {
    await apiFetchJSON('/api/v1/auth/password', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ current_password: document.getElementById('pw-cur').value, new_password: document.getElementById('pw-new').value })
    });
    closeModal(); toast('Password updated');
  } catch (e) { toast('Error: ' + e.message); }
}
async function doLogout() {
  await fetch('/api/v1/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const collapsed = sb.classList.toggle('collapsed');
  const btn = document.getElementById('sb-toggle-btn');
  if (btn) {
    btn.textContent = collapsed ? '»' : '«';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
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
    if (closeActiveDropdown(true)) return;
    closeDisplayMenu();
    if (S.tvMode) { toggleTVMode(); return; }
    if (document.getElementById('confirm-backdrop')?.classList.contains('open')) resolveConfirm(false);
    else if (document.getElementById('qj-backdrop')?.classList.contains('open')) closeQuickJump();
    else if (document.getElementById('modal-backdrop')?.classList.contains('open')) closeModal();
    else { closeDrawer(); closeMobileSidebar(); }
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
  if (!h.has_been_checked) return '<span class="badge c-pend"><img src="/assets/status/status-offline.svg" alt="">PENDING</span>';
  const m = {0:['UP','c-ok','status-ok.svg'],1:['DOWN','c-crit','status-critical.svg'],2:['UNREACH','c-warn','status-warn.svg']};
  const [l,c,ic] = m[h.current_state] || ['UNK','c-unk','status-info.svg'];
  return `<span class="badge ${c}"><img src="/assets/status/${ic}" alt="">${l}</span>`;
}
function svcBadge(s) {
  if (!s.has_been_checked) return '<span class="badge c-pend"><img src="/assets/status/status-offline.svg" alt="">PENDING</span>';
  const m = {0:['OK','c-ok','status-ok.svg'],1:['WARN','c-warn','status-warn.svg'],2:['CRIT','c-crit','status-critical.svg'],3:['UNK','c-unk','status-info.svg']};
  const [l,c,ic] = m[s.current_state] || ['UNK','c-unk','status-info.svg'];
  return `<span class="badge ${c}"><img src="/assets/status/${ic}" alt="">${l}</span>`;
}
function flagsHTML(o) {
  let out = '';
  if (o.acknowledged) out += '<span class="flag-tag" title="Problem acknowledged">ACK</span>';
  if (o.downtime_depth > 0) out += '<span class="flag-tag" title="In scheduled downtime">DT</span>';
  if (o.is_flapping) out += '<span class="flag-tag" title="State is flapping rapidly">FLAP</span>';
  if (o.state_type === 0 && o.current_state > 0) out += '<span class="flag-tag" title="SOFT state — retrying before HARD alert">SOFT</span>';
  return out ? `<span class="flags">${out}</span>` : '';
}

function openModal(html) { closeActiveDropdown(); document.getElementById('modal-content').innerHTML = html; document.getElementById('modal-backdrop').classList.add('open'); }
function closeModal() { closeActiveDropdown(); document.getElementById('modal-backdrop').classList.remove('open'); }
function closeDrawer() { closeActiveDropdown(); document.getElementById('drawer-wrap').classList.remove('open'); }

/* Modern Confirmation Dialog */
let _confirmResolver = null;
function encoreConfirm({ title, message, items = [], confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    _confirmResolver = resolve;
    const iconSVG = danger ? uiIcon('alert', 'lg') : uiIcon('info', 'lg');
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

/* Crisp Vector Empty-State Icon (Replaces Pixel Mascots in Operate Views) */
function artSVG(kind) {
  const map = {
    'radar-ok': ['ok', 'ok'],
    'servers': ['server', ''],
    'search': ['search', ''],
    '403': ['shield', ''],
    '503': ['alert', '']
  };
  const [ic, cls] = map[kind] || ['server', ''];
  return `<div class="empty-ico ${cls}">${uiIcon(ic, 'lg')}</div>`;
}

function isUserInteracting() {
  if (document.getElementById('ec-dd-portal')?.classList.contains('open')) return true;
  if (document.getElementById('modal-backdrop')?.classList.contains('open')) return true;
  if (document.getElementById('confirm-backdrop')?.classList.contains('open')) return true;
  if (document.getElementById('drawer-wrap')?.classList.contains('open')) return true;
  if (document.getElementById('qj-backdrop')?.classList.contains('open')) return true;
  if (S.selectedMon.size > 0) return true;
  return false;
}

async function sendCmd(cmd, label, btnEl) {
  if (btnEl) btnEl.disabled = true;
  try {
    await apiFetchJSON('/api/v1/command', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command: cmd}) });
    toast(label + ' queued');
    setTimeout(refreshAll, 700);
  } catch (e) { toast('Error: ' + e.message); }
  finally { if (btnEl) btnEl.disabled = false; }
}

async function sendBatchCmds(commands, label) {
  try {
    const d = await apiFetchJSON('/api/v1/commands/batch', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({commands}) });
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

function setView(v, sub, fromHash) {
  const apply = () => {
    if (S.view === 'inventory' || S.view === 'problems') saveMonitorFilterState(S.view);
    S.view = v;
    S.offset = 0;
    S.selectedMon.clear();
    closeMobileSidebar();
    closeDisplayMenu();
    document.getElementById('page-title').textContent = VIEW_TITLES[v] || v;
    document.querySelectorAll('.nav-item').forEach(el => {
      const isAct = el.id === 'nav-' + v;
      el.classList.toggle('active', isAct);
      if (isAct) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });

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
    if (!fromHash) syncHashFromState();
  };

  if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(apply);
  } else {
    apply();
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
    b.textContent = 'Paused';
    b.classList.remove('active');
    b.title = 'Live updates paused — click to resume';
  } else {
    b.textContent = S.sseConnected ? 'Live' : 'Sync';
    b.classList.add('active');
    b.title = S.sseConnected ? 'Real-time SSE push active (click to pause)' : 'Fallback 5s sync active (click to pause)';
  }
}
function setAutoInterval() {
  updateLiveToggleBtn();
  clearInterval(S.timer);
  if (S.livePaused) { S.autoMs = 0; return; }
  S.autoMs = S.sseConnected ? 30000 : 5000;
  S.timer = setInterval(() => {
    if (!S.livePaused && !isUserInteracting()) refreshAll();
  }, S.autoMs);
}

async function refreshAll() {
  try {
    await loadMeta();
    S.lastGoodSync = Date.now();
    setConnectionBanner(false);
    if (S.view === 'overview') await loadOverview();
    else if (S.view === 'inventory' || S.view === 'problems') await loadMonitorView();
  } catch (e) {
    const dot = document.getElementById('conn-dot');
    if (dot) dot.className = 'pulse-dot crit';
    const lbl = document.getElementById('conn-label');
    if (lbl) lbl.textContent = 'Offline';
    setConnectionBanner(true, 'Unable to reach Encore State Gateway (' + e.message + ').');
  }
}

/* Keyboard-Navigable Quick Jump Palette (Ctrl+K) */
let qjHostsCache = [];
let qjSelectedIdx = 0;
async function openQuickJump() {
  document.getElementById('qj-backdrop').classList.add('open');
  const inp = document.getElementById('qj-input');
  inp.value = '';
  qjSelectedIdx = 0;
  inp.focus();
  try {
    const d = await apiFetchJSON('/api/v1/hosts?limit=200');
    qjHostsCache = d.hosts || [];
  } catch (e) {}
  renderQuickJump();
}
function closeQuickJump() { document.getElementById('qj-backdrop').classList.remove('open'); }
function onQuickJumpKey(e) {
  const list = window._qjActions || [];
  if (!list.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    qjSelectedIdx = (qjSelectedIdx + 1) % list.length;
    highlightQuickJumpRow();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    qjSelectedIdx = (qjSelectedIdx - 1 + list.length) % list.length;
    highlightQuickJumpRow();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const act = list[qjSelectedIdx];
    if (act) { closeQuickJump(); act.run(); }
  }
}
function highlightQuickJumpRow() {
  document.querySelectorAll('#qj-list .qj-item').forEach((el, i) => {
    const active = i === qjSelectedIdx;
    el.classList.toggle('qj-active', active);
    if (active) el.scrollIntoView({ block: 'nearest' });
  });
}
function renderQuickJump() {
  const q = (document.getElementById('qj-input')?.value || '').trim().toLowerCase();
  const staticItems = [
    { label: 'Overview — Fleet Map & Incidents', tag: 'Page', run: () => setView('overview') },
    { label: 'Inventory — By Host (Host & Services)', tag: 'Page', run: () => setView('inventory','byhost') },
    { label: 'Inventory — All Services', tag: 'Page', run: () => setView('inventory','services') },
    { label: 'Inventory — Hosts Only', tag: 'Page', run: () => setView('inventory','hosts') },
    { label: 'Active Problems', tag: 'Page', run: () => setView('problems','active') },
    { label: 'Historical Reports & SLA Charts', tag: 'Page', run: () => setView('reports','sla') },
    ...(isAdmin() ? [
      { label: 'Manage — Hosts & Services', tag: 'Config', run: () => setView('manage','objects') },
      { label: 'Manage — Service Templates', tag: 'Config', run: () => setView('manage','templates') },
      { label: 'Manage — Email & Webhook Notifications', tag: 'Config', run: () => setView('manage','notifications') },
      { label: 'Manage — Commands & Scripts', tag: 'Config', run: () => setView('manage','commands') },
      { label: 'Manage — Secrets ($USERn$)', tag: 'Config', run: () => setView('manage','secrets') },
      { label: 'Review Pending Config Diff', tag: 'Config', run: () => openDiffReviewModal() },
      { label: 'Add New Host', tag: 'Action', run: () => { setView('manage','objects'); setTimeout(() => openHostForm(-1), 250); } },
      { label: 'Add New Service', tag: 'Action', run: () => { setView('manage','objects'); setTimeout(() => openSvcForm(-1), 250); } }
    ] : []),
    { label: 'User Guide — Menus & Features', tag: 'Help', run: () => setView('guide','menus') },
    { label: 'User Guide — NCPA Quick Install', tag: 'Help', run: () => setView('guide','ncpa') }
  ];
  const hostItems = qjHostsCache.map(h => ({
    label: `${h.name} (${h.address})`,
    tag: 'Host',
    run: () => {
      document.getElementById('global-search').value = h.name;
      S.invCollapsedHosts.delete(h.name);
      S.invExpandedHosts.add(h.name);
      setView('inventory', 'byhost');
    }
  }));
  const all = [...staticItems, ...hostItems].filter(it => !q || it.label.toLowerCase().includes(q) || it.tag.toLowerCase().includes(q)).slice(0, 14);
  window._qjActions = all;
  qjSelectedIdx = 0;
  document.getElementById('qj-list').innerHTML = all.length ? all.map((it, i) => `
    <button type="button" class="qj-item ${i===0?'qj-active':''}" onclick="closeQuickJump();window._qjActions[${i}].run()">
      <span>${esc(it.label)}</span><span class="flag-tag">${esc(it.tag)}</span>
    </button>`).join('') : '<div class="empty" style="padding:18px">No matches</div>';
}

/* ==========================================================================
   ENCORE SLEEK DROPDOWN (Automatic Progressive Enhancement for <select>)
   Keeps native <select> in DOM so .value, .options, .innerHTML & onchange work
   ========================================================================== */
const DD_THEME_SWATCHES = {
  light: '#d9381e',
  dark: '#ff5733',
  cyber: '#22e3ff',
  nord: '#88c0d0',
  emerald: '#10b981'
};
const _ddState = { activeSel: null, hiIdx: -1, portal: null, bodyObs: null };

function getDropdownPortal() {
  if (_ddState.portal && document.body.contains(_ddState.portal)) return _ddState.portal;
  const p = document.createElement('div');
  p.id = 'ec-dd-portal';
  p.className = 'ec-dd-menu';
  p.setAttribute('role', 'listbox');
  p.addEventListener('click', e => e.stopPropagation());
  document.body.appendChild(p);
  _ddState.portal = p;
  return p;
}

function closeActiveDropdown(restoreFocus = false) {
  const sel = _ddState.activeSel;
  if (!sel) return false;
  const portal = _ddState.portal;
  if (portal) {
    portal.classList.remove('open', 'flip-up');
    portal.innerHTML = '';
  }
  if (sel._ecDd) {
    sel._ecDd.wrap.classList.remove('open');
    sel._ecDd.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) sel._ecDd.trigger.focus();
  }
  _ddState.activeSel = null;
  _ddState.hiIdx = -1;
  return true;
}

function ddSwatchHTML(sel, val) {
  if (sel.id !== 'theme-select' && sel.id !== 'theme-sel') return '';
  const col = DD_THEME_SWATCHES[val];
  return col ? `<span class="ec-dd-swatch" style="background:${col}"></span>` : '';
}

function syncDropdownUI(sel) {
  const dd = sel && sel._ecDd;
  if (!dd) return;
  const { wrap, trigger, label } = dd;
  const hidden = sel.style.display === 'none' || sel.hidden;
  wrap.style.display = hidden ? 'none' : (sel.style.flex ? 'flex' : '');
  wrap.style.flex = sel.style.flex || '';
  if (sel.style.width) wrap.style.width = sel.style.width;
  trigger.disabled = !!sel.disabled;

  const opt = sel.options[sel.selectedIndex] || sel.options[0];
  const txt = opt ? opt.textContent : '';
  const val = opt ? opt.value : '';
  label.innerHTML = `${ddSwatchHTML(sel, val)}<span>${esc(txt)}</span>`;

  const hasEmptyDefault = sel.options.length > 0 && sel.options[0].value === '';
  wrap.classList.toggle('has-val', hasEmptyDefault && val !== '');

  if (_ddState.activeSel === sel) {
    renderDropdownOptions(sel);
  }
}

function renderDropdownOptions(sel) {
  const portal = getDropdownPortal();
  const opts = Array.from(sel.options);
  let html = '';
  let lastGroup = null;
  opts.forEach((opt, idx) => {
    if (opt.hidden) return;
    const grp = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement.label : null;
    if (grp && grp !== lastGroup) {
      html += `<div class="ec-dd-group">${esc(grp)}</div>`;
      lastGroup = grp;
    }
    const isSel = idx === sel.selectedIndex;
    const isHi = idx === _ddState.hiIdx;
    html += `
      <button type="button" class="ec-dd-opt ${isSel ? 'is-sel' : ''} ${isHi ? 'is-hi' : ''}" role="option" data-idx="${idx}" aria-selected="${isSel ? 'true' : 'false'}" ${opt.disabled ? 'disabled' : ''}>
        <span class="ec-dd-opt-text">${ddSwatchHTML(sel, opt.value)}<span>${esc(opt.textContent)}</span></span>
        <svg class="ec-dd-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      </button>`;
  });
  portal.innerHTML = html || '<div class="ec-dd-group">No options</div>';
  portal.querySelectorAll('.ec-dd-opt').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const idx = Number(btn.dataset.idx);
      selectDropdownIndex(sel, idx);
    });
    btn.addEventListener('mouseenter', () => {
      _ddState.hiIdx = Number(btn.dataset.idx);
      highlightDropdownItem();
    });
  });
}

function highlightDropdownItem() {
  const portal = _ddState.portal;
  if (!portal) return;
  portal.querySelectorAll('.ec-dd-opt').forEach(btn => {
    const active = Number(btn.dataset.idx) === _ddState.hiIdx;
    btn.classList.toggle('is-hi', active);
    if (active) btn.scrollIntoView({ block: 'nearest' });
  });
}

function selectDropdownIndex(sel, idx) {
  if (!sel || idx < 0 || idx >= sel.options.length || sel.options[idx].disabled) return;
  const changed = sel.selectedIndex !== idx;
  sel.selectedIndex = idx;
  syncDropdownUI(sel);
  closeActiveDropdown(true);
  if (changed) {
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function positionDropdownPortal(trigger, portal) {
  const r = trigger.getBoundingClientRect();
  const minW = Math.min(Math.max(r.width, 160), window.innerWidth - 20);
  portal.style.minWidth = minW + 'px';
  portal.style.maxWidth = Math.min(340, window.innerWidth - 20) + 'px';
  portal.style.visibility = 'hidden';
  portal.classList.add('open');
  const pr = portal.getBoundingClientRect();
  const spaceBelow = window.innerHeight - r.bottom - 10;
  const spaceAbove = r.top - 10;
  const flipUp = spaceBelow < Math.min(pr.height, 220) && spaceAbove > spaceBelow;
  portal.classList.toggle('flip-up', flipUp);
  const top = flipUp ? Math.max(10, r.top - pr.height - 6) : Math.min(window.innerHeight - pr.height - 10, r.bottom + 6);
  const left = Math.min(Math.max(10, r.left), Math.max(10, window.innerWidth - pr.width - 10));
  portal.style.top = top + 'px';
  portal.style.left = left + 'px';
  portal.style.visibility = '';
}

function openDropdown(sel) {
  if (!sel || !sel._ecDd || sel.disabled) return;
  if (_ddState.activeSel === sel) {
    closeActiveDropdown(true);
    return;
  }
  closeActiveDropdown(false);
  _ddState.activeSel = sel;
  _ddState.hiIdx = Math.max(0, sel.selectedIndex);
  const portal = getDropdownPortal();
  renderDropdownOptions(sel);
  sel._ecDd.wrap.classList.add('open');
  sel._ecDd.trigger.setAttribute('aria-expanded', 'true');
  positionDropdownPortal(sel._ecDd.trigger, portal);
  const activeBtn = portal.querySelector('.ec-dd-opt.is-sel') || portal.querySelector('.ec-dd-opt');
  if (activeBtn) activeBtn.scrollIntoView({ block: 'nearest' });
}

function moveDropdownHighlight(delta) {
  const sel = _ddState.activeSel;
  if (!sel) return;
  const opts = Array.from(sel.options);
  const valid = opts.map((o, i) => (!o.disabled && !o.hidden ? i : -1)).filter(i => i >= 0);
  if (!valid.length) return;
  const pos = valid.indexOf(_ddState.hiIdx);
  const next = pos < 0 ? valid[0] : valid[(pos + delta + valid.length) % valid.length];
  _ddState.hiIdx = next;
  highlightDropdownItem();
}

function enhanceSelect(sel) {
  if (!sel || sel._ecDd || sel.multiple || sel.size > 1 || sel.dataset.nativeSelect === '1') return;
  if (!sel.parentNode) return;

  const wrap = document.createElement('div');
  wrap.className = 'ec-dd';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('ec-dd-native');
  sel.tabIndex = -1;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ec-dd-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const ariaLbl = sel.getAttribute('aria-label') || sel.getAttribute('title');
  if (ariaLbl) trigger.setAttribute('aria-label', ariaLbl);

  const label = document.createElement('span');
  label.className = 'ec-dd-label';
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('class', 'ec-dd-chev');
  chev.setAttribute('viewBox', '0 0 24 24');
  chev.setAttribute('aria-hidden', 'true');
  chev.innerHTML = '<path d="m6 9 6 6 6-6"/>';
  trigger.appendChild(label);
  trigger.appendChild(chev);
  wrap.appendChild(trigger);

  sel._ecDd = { wrap, trigger, label };

  const valDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (valDesc && valDesc.get && valDesc.set) {
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return valDesc.get.call(this); },
      set(v) { valDesc.set.call(this, v); syncDropdownUI(this); }
    });
  }

  sel.addEventListener('change', () => syncDropdownUI(sel));
  sel.addEventListener('focus', () => trigger.focus());
  trigger.addEventListener('click', ev => {
    ev.stopPropagation();
    openDropdown(sel);
  });
  trigger.addEventListener('keydown', ev => {
    const isOpen = _ddState.activeSel === sel;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!isOpen) openDropdown(sel); else moveDropdownHighlight(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!isOpen) openDropdown(sel); else moveDropdownHighlight(-1);
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (!isOpen) openDropdown(sel);
      else if (_ddState.hiIdx >= 0) selectDropdownIndex(sel, _ddState.hiIdx);
    } else if (ev.key === 'Tab' && isOpen) {
      closeActiveDropdown(false);
    }
  });

  const obs = new MutationObserver(() => syncDropdownUI(sel));
  obs.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'disabled', 'hidden'] });
  syncDropdownUI(sel);
}

function initEncoreDropdowns() {
  document.querySelectorAll('select').forEach(enhanceSelect);
  if (_ddState.bodyObs) return;
  _ddState.bodyObs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || n.id === 'ec-dd-portal') continue;
        if (n.tagName === 'SELECT') enhanceSelect(n);
        else if (n.querySelectorAll) n.querySelectorAll('select').forEach(enhanceSelect);
      }
    }
  });
  _ddState.bodyObs.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', e => {
    if (!_ddState.activeSel) return;
    const dd = _ddState.activeSel._ecDd;
    const portal = _ddState.portal;
    if (dd && dd.wrap.contains(e.target)) return;
    if (portal && portal.contains(e.target)) return;
    closeActiveDropdown(false);
  });
  window.addEventListener('resize', () => closeActiveDropdown(false));
  window.addEventListener('scroll', e => {
    if (_ddState.activeSel && _ddState.portal && e.target !== _ddState.portal && !_ddState.portal.contains(e.target)) {
      closeActiveDropdown(false);
    }
  }, true);
}

initEncoreDropdowns();
