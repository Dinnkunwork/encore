/* ==========================================================================
   ENCORE THEME-AWARE SVG ICON & HOST OS/DEVICE ICON REGISTRY
   All icons inherit CSS theme tokens (5 themes: light, dark, cyber, nord, emerald)
   ========================================================================== */
(() => {
  const LOGO_SVG = `
    <rect x="2" y="2" width="32" height="32" rx="9" fill="var(--accent)"/>
    <rect x="2.75" y="2.75" width="30.5" height="30.5" rx="8.25" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
    <path d="M11 11.5h13.5M11 18h9.5M11 24.5h13.5" stroke="var(--accent-fg)" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="24.5" cy="18" r="2.2" fill="var(--accent-fg)"/>`;

  function encoreLogoSVG(size = 28, cls = 'brand-svg') {
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 36 36" fill="none" aria-hidden="true">${LOGO_SVG}</svg>`;
  }

  /* 24 Curated OS, Virtualization, Network & Workload Icons (24x24 duotone stroke) */
  const HOST_ICONS = [
    // Operating Systems
    { id: 'linux', label: 'Linux', cat: 'OS', svg: '<path d="M12 3.5c-2.6 0-4.2 1.9-4.2 4.6 0 1.4.4 2.5-.6 3.9-1 1.4-2 2.9-2 4.7 0 2.3 1.7 3.8 4 3.8h5.6c2.3 0 4-1.5 4-3.8 0-1.8-1-3.3-2-4.7-1-1.4-.6-2.5-.6-3.9 0-2.7-1.6-4.6-4.2-4.6Z" fill="currentColor" fill-opacity="0.12"/><path d="M12 3.5c-2.6 0-4.2 1.9-4.2 4.6 0 1.4.4 2.5-.6 3.9-1 1.4-2 2.9-2 4.7 0 2.3 1.7 3.8 4 3.8h5.6c2.3 0 4-1.5 4-3.8 0-1.8-1-3.3-2-4.7-1-1.4-.6-2.5-.6-3.9 0-2.7-1.6-4.6-4.2-4.6Z"/><circle cx="10.4" cy="7.8" r="0.7" fill="currentColor"/><circle cx="13.6" cy="7.8" r="0.7" fill="currentColor"/><path d="M10.5 10.2c.9.7 2.1.7 3 0M9 20.5h2.2M12.8 20.5H15"/>' },
    { id: 'windows', label: 'Windows', cat: 'OS', svg: '<path d="M3.5 5.6 10.8 4.5v6.8H3.5V5.6Zm8.7-1.3 8.3-1.2v8.2h-8.3V4.3ZM3.5 12.7h7.3v6.8l-7.3-1.1v-5.7Zm8.7 0h8.3v8.2l-8.3-1.2v-7Z" fill="currentColor" fill-opacity="0.12"/><path d="M3.5 5.6 10.8 4.5v6.8H3.5V5.6Zm8.7-1.3 8.3-1.2v8.2h-8.3V4.3ZM3.5 12.7h7.3v6.8l-7.3-1.1v-5.7Zm8.7 0h8.3v8.2l-8.3-1.2v-7Z"/>' },
    { id: 'ubuntu', label: 'Ubuntu', cat: 'OS', svg: '<circle cx="12" cy="12" r="5.5" fill="currentColor" fill-opacity="0.12"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="4.2" r="1.6" fill="var(--accent)" stroke="var(--accent)"/><circle cx="5.4" cy="15.8" r="1.6" fill="var(--accent)" stroke="var(--accent)"/><circle cx="18.6" cy="15.8" r="1.6" fill="var(--accent)" stroke="var(--accent)"/>' },
    { id: 'debian', label: 'Debian', cat: 'OS', svg: '<circle cx="12" cy="12" r="8.5" fill="currentColor" fill-opacity="0.10"/><path d="M14.5 20A8.5 8.5 0 1 1 20 11.2c0 3.3-2.4 5.5-5.3 5.5-2.6 0-4.4-1.8-4.4-4.1 0-1.9 1.3-3.2 3-3.2 1.3 0 2.3.9 2.3 2.1 0 1-.7 1.6-1.6 1.6"/>' },
    { id: 'rhel', label: 'RHEL / Rocky', cat: 'OS', svg: '<path d="M6.5 13.2 8.2 7.5c.3-1 1.3-1.5 2.3-1.2l1.5.5 1.5-.5c1-.3 2 .2 2.3 1.2l1.7 5.7" fill="currentColor" fill-opacity="0.14"/><path d="M6.5 13.2 8.2 7.5c.3-1 1.3-1.5 2.3-1.2l1.5.5 1.5-.5c1-.3 2 .2 2.3 1.2l1.7 5.7"/><ellipse cx="12" cy="14.6" rx="8.5" ry="3.2" fill="currentColor" fill-opacity="0.10"/><ellipse cx="12" cy="14.6" rx="8.5" ry="3.2"/>' },
    { id: 'alpine', label: 'Alpine', cat: 'OS', svg: '<path d="M3 17.5 9.2 7.5l4.2 6.8 2.4-3.6L21 17.5H3Z" fill="currentColor" fill-opacity="0.14"/><path d="M3 17.5 9.2 7.5l4.2 6.8 2.4-3.6L21 17.5H3Z"/><path d="M7.2 11h4"/>' },
    { id: 'macos', label: 'macOS', cat: 'OS', svg: '<path d="M15.2 6.2c1.8 0 3.3 1 4 2.4-1.4.8-2 2.2-1.8 3.8.2 1.5 1.2 2.5 2.3 3-.5 1.5-1.6 3.6-3.1 4.4-1 .5-1.8.2-2.8-.2-.9-.3-1.7-.3-2.6 0-1 .4-1.8.7-2.8.2C6.4 18.8 4.8 15.1 5 11.7c.2-3 2.2-5.3 4.8-5.3 1.1 0 2 .5 2.7.5.7 0 1.6-.7 2.7-.7Z" fill="currentColor" fill-opacity="0.12"/><path d="M15.2 6.2c1.8 0 3.3 1 4 2.4-1.4.8-2 2.2-1.8 3.8.2 1.5 1.2 2.5 2.3 3-.5 1.5-1.6 3.6-3.1 4.4-1 .5-1.8.2-2.8-.2-.9-.3-1.7-.3-2.6 0-1 .4-1.8.7-2.8.2C6.4 18.8 4.8 15.1 5 11.7c.2-3 2.2-5.3 4.8-5.3 1.1 0 2 .5 2.7.5.7 0 1.6-.7 2.7-.7Z"/><path d="M12.5 5.4c.1-1.3 1-2.4 2.2-2.7"/>' },
    { id: 'freebsd', label: 'FreeBSD', cat: 'OS', svg: '<circle cx="12" cy="13" r="6.8" fill="currentColor" fill-opacity="0.12"/><circle cx="12" cy="13" r="6.8"/><path d="M6.8 8.3 4.5 4.8c1.6.3 3 1.1 4 2.2M17.2 8.3l2.3-3.5c-1.6.3-3 1.1-4 2.2"/><path d="M9.6 13h4.8"/>' },

    // Virtualization, Containers & Cloud
    { id: 'proxmox', label: 'Proxmox', cat: 'Infra', svg: '<rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" fill-opacity="0.10"/><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7.5 8 4.5 4-4.5 4" stroke="var(--accent)" stroke-width="2.1"/><path d="m16.5 8-4.5 4 4.5 4"/>' },
    { id: 'vmware', label: 'VMware / ESXi', cat: 'Infra', svg: '<rect x="3.5" y="3.5" width="10.5" height="10.5" rx="2.5" fill="currentColor" fill-opacity="0.12"/><rect x="10" y="10" width="10.5" height="10.5" rx="2.5" fill="currentColor" fill-opacity="0.12"/><rect x="3.5" y="3.5" width="10.5" height="10.5" rx="2.5"/><rect x="10" y="10" width="10.5" height="10.5" rx="2.5"/>' },
    { id: 'docker', label: 'Docker', cat: 'Infra', svg: '<path d="M3 13.5h15.5c1.3 0 2.5-.6 3-1.8-.9-.6-2-.7-3-.3-.3-1.1-1.1-1.9-2.2-2.2-.7.9-.9 2.1-.6 3.1H3c0 3.7 2.7 6.2 7 6.2 4.6 0 8.2-2.2 9.8-6.2" fill="currentColor" fill-opacity="0.12"/><path d="M3 13.5h15.5c1.3 0 2.5-.6 3-1.8-.9-.6-2-.7-3-.3-.3-1.1-1.1-1.9-2.2-2.2-.7.9-.9 2.1-.6 3.1H3c0 3.7 2.7 6.2 7 6.2 4.6 0 8.2-2.2 9.8-6.2"/><path d="M6 10.5h2.5V8H6v2.5Zm3.5 0H12V8H9.5v2.5Zm3.5 0h2.5V8H13v2.5ZM9.5 7H12V4.5H9.5V7Z"/>' },
    { id: 'kubernetes', label: 'Kubernetes', cat: 'Infra', svg: '<polygon points="12 3 19.5 7 21 15.2 15.8 21 8.2 21 3 15.2 4.5 7" fill="currentColor" fill-opacity="0.12"/><polygon points="12 3 19.5 7 21 15.2 15.8 21 8.2 21 3 15.2 4.5 7"/><circle cx="12" cy="12" r="2.6"/><path d="M12 5.5v3.9M12 14.6v3.9M6.2 9l3.4 1.8M14.4 13.2 17.8 15M17.8 9l-3.4 1.8M9.6 13.2 6.2 15"/>' },
    { id: 'cloud', label: 'Cloud / VPS', cat: 'Infra', svg: '<path d="M7 18.5h10.5a4 4 0 0 0 .8-7.9A5.5 5.5 0 0 0 7.7 8.5 4.2 4.2 0 0 0 7 18.5Z" fill="currentColor" fill-opacity="0.13"/><path d="M7 18.5h10.5a4 4 0 0 0 .8-7.9A5.5 5.5 0 0 0 7.7 8.5 4.2 4.2 0 0 0 7 18.5Z"/>' },
    { id: 'server', label: 'Rack Server', cat: 'Infra', svg: '<rect x="3" y="4" width="18" height="6.5" rx="2" fill="currentColor" fill-opacity="0.12"/><rect x="3" y="13.5" width="18" height="6.5" rx="2" fill="currentColor" fill-opacity="0.12"/><rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><circle cx="7" cy="7.25" r="0.9" fill="var(--accent)" stroke="none"/><circle cx="7" cy="16.75" r="0.9" fill="var(--accent)" stroke="none"/><path d="M11 7.25h6M11 16.75h6"/>' },

    // Networking, Storage & Workloads
    { id: 'mikrotik', label: 'MikroTik', cat: 'Network', svg: '<rect x="3" y="4" width="18" height="16" rx="3.5" fill="currentColor" fill-opacity="0.10"/><rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M6.8 15.5V8.8l3.2 3.8 3.2-3.8v6.7"/><path d="M16 9.5v6M18 11.5v4" stroke="var(--accent)"/>' },
    { id: 'cisco', label: 'Cisco', cat: 'Network', svg: '<path d="M4 13v3M7 10v6M10 7v9M14 7v9M17 10v6M20 13v3" stroke-width="2"/><path d="M3 19h18" stroke="var(--accent)"/>' },
    { id: 'network', label: 'Router / Switch', cat: 'Network', svg: '<rect x="3" y="13" width="18" height="7" rx="2" fill="currentColor" fill-opacity="0.12"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M10.5 16.5h.01M14 16.5h3M8 13V6M16 13V8M5.5 8.5 8 6l2.5 2.5M13.5 10.5 16 8l2.5 2.5"/>' },
    { id: 'firewall', label: 'Firewall', cat: 'Network', svg: '<path d="M12 3 4.5 6.2v5.6c0 4.8 3.2 7.9 7.5 9.2 4.3-1.3 7.5-4.4 7.5-9.2V6.2L12 3Z" fill="currentColor" fill-opacity="0.12"/><path d="M12 3 4.5 6.2v5.6c0 4.8 3.2 7.9 7.5 9.2 4.3-1.3 7.5-4.4 7.5-9.2V6.2L12 3Z"/><path d="M8.5 11.5h7M12 8.5v6" stroke="var(--accent)"/>' },
    { id: 'wifi', label: 'Access Point', cat: 'Network', svg: '<path d="M3.8 9.8a11.5 11.5 0 0 1 16.4 0M6.8 13a7.5 7.5 0 0 1 10.4 0M9.8 16.2a3.3 3.3 0 0 1 4.4 0"/><circle cx="12" cy="19" r="1.4" fill="var(--accent)" stroke="var(--accent)"/>' },
    { id: 'loadbalancer', label: 'Load Balancer', cat: 'Network', svg: '<circle cx="5" cy="12" r="2.2" fill="var(--accent)" stroke="var(--accent)"/><circle cx="19" cy="6" r="2.2" fill="currentColor" fill-opacity="0.14"/><circle cx="19" cy="12" r="2.2" fill="currentColor" fill-opacity="0.14"/><circle cx="19" cy="18" r="2.2" fill="currentColor" fill-opacity="0.14"/><circle cx="19" cy="6" r="2.2"/><circle cx="19" cy="12" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7.2 12h4.3L16.8 6M7.2 12h9.6M11.5 12l5.3 6"/>' },
    { id: 'database', label: 'Database', cat: 'Workload', svg: '<ellipse cx="12" cy="6" rx="7.5" ry="2.8" fill="currentColor" fill-opacity="0.14"/><ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>' },
    { id: 'web', label: 'Web / Nginx', cat: 'Workload', svg: '<circle cx="12" cy="12" r="8.5" fill="currentColor" fill-opacity="0.10"/><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.8" ry="8.5"/><path d="M4 9.5h16M4 14.5h16"/>' },
    { id: 'synology', label: 'Synology / NAS', cat: 'Workload', svg: '<rect x="4" y="3.5" width="16" height="17" rx="2.5" fill="currentColor" fill-opacity="0.11"/><rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M9.5 3.5v17M14.5 3.5v17"/><circle cx="6.8" cy="17" r="0.8" fill="var(--accent)" stroke="none"/><circle cx="12" cy="17" r="0.8" fill="var(--accent)" stroke="none"/><circle cx="17.2" cy="17" r="0.8" fill="var(--accent)" stroke="none"/>' },
    { id: 'iot', label: 'IoT / Edge', cat: 'Workload', svg: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" fill-opacity="0.14"/><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/><circle cx="12" cy="12" r="1.6" fill="var(--accent)" stroke="none"/>' }
  ];

  const HOST_ICON_MAP = new Map(HOST_ICONS.map(it => [it.id, it]));

  function inferHostIcon(hostName, hostgroups) {
    const s = (String(hostName || '') + ' ' + (Array.isArray(hostgroups) ? hostgroups.join(' ') : '')).toLowerCase();
    if (!s.trim()) return 'server';
    if (/(win|windows|ad-|dc-|mssql|iis|exchange|rdp)/.test(s)) return 'windows';
    if (/(ubuntu|ubt)/.test(s)) return 'ubuntu';
    if (/(debian|deb-)/.test(s)) return 'debian';
    if (/(rhel|centos|rocky|alma|redhat|fedora)/.test(s)) return 'rhel';
    if (/(alpine)/.test(s)) return 'alpine';
    if (/(macos|osx|apple|macbook|imac)/.test(s)) return 'macos';
    if (/(freebsd|bsd|truenas)/.test(s)) return 'freebsd';
    if (/(proxmox|pve)/.test(s)) return 'proxmox';
    if (/(vmware|esxi|vcenter)/.test(s)) return 'vmware';
    if (/(k8s|kube|cluster)/.test(s)) return 'kubernetes';
    if (/(docker|container|podman)/.test(s)) return 'docker';
    if (/(mikrotik|mt-|rb[0-9]|ccr)/.test(s)) return 'mikrotik';
    if (/(cisco|catalyst|nexus|asr)/.test(s)) return 'cisco';
    if (/(firewall|fw-|pfsense|opnsense|forti|sophos|palo)/.test(s)) return 'firewall';
    if (/(wifi|wlan|ap-|unifi)/.test(s)) return 'wifi';
    if (/(haproxy|lb-|loadbal|traefik|f5)/.test(s)) return 'loadbalancer';
    if (/(router|switch|sw-|rt-|gw-|gateway|core-net)/.test(s)) return 'network';
    if (/(synology|qnap|nas|storage|minio|ceph)/.test(s)) return 'synology';
    if (/(mysql|postgres|pgsql|mariadb|mongo|redis|oracle|db-|db[0-9]|database)/.test(s)) return 'database';
    if (/(nginx|apache|web-|www|http|proxy|cdn)/.test(s)) return 'web';
    if (/(aws|gcp|azure|cloud|vps|ec2)/.test(s)) return 'cloud';
    if (/(iot|edge|sensor|cam|printer|cctv)/.test(s)) return 'iot';
    if (/(linux|lnx|localhost)/.test(s)) return 'linux';
    return 'server';
  }

  function resolveHostIcon(iconId, hostName, hostgroups) {
    const key = String(iconId || '').trim().toLowerCase();
    if (key && HOST_ICON_MAP.has(key)) return HOST_ICON_MAP.get(key);
    const inferred = inferHostIcon(hostName, hostgroups);
    return HOST_ICON_MAP.get(inferred) || HOST_ICON_MAP.get('server');
  }

  function hostIconSVG(iconId, hostName, hostgroups, size = 15) {
    const meta = resolveHostIcon(iconId, hostName, hostgroups);
    return `<svg class="host-ico-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${meta.svg}</svg>`;
  }

  function hostIconBadge(hostObj, size = 'md') {
    const h = hostObj || {};
    const meta = resolveHostIcon(h.icon, h.name || h.host_name, h.hostgroups);
    const px = size === 'lg' ? 19 : (size === 'sm' ? 13 : 15);
    const title = h.icon ? `${meta.label}` : `${meta.label} (Auto)`;
    return `<span class="host-ico-badge ${size}" title="${title}" aria-label="${title}">${hostIconSVG(meta.id, '', null, px)}</span>`;
  }

  /* Backward-compatible <encore-icon> custom element now renders clean theme-aware SVGs */
  class EncoreIconElement extends HTMLElement {
    connectedCallback() {
      const n = this.getAttribute('name') || 'server';
      const sz = Math.max(16, (Number(this.getAttribute('size')) || 2) * 8);
      if (n === 'logo') {
        this.innerHTML = encoreLogoSVG(sz);
      } else {
        const meta = HOST_ICON_MAP.get(n) || HOST_ICON_MAP.get('server');
        this.innerHTML = `<span class="host-ico-badge lg">${hostIconSVG(meta.id, '', null, Math.round(sz * 0.6))}</span>`;
      }
    }
  }
  if (!customElements.get('encore-icon')) customElements.define('encore-icon', EncoreIconElement);

  window.HOST_ICONS = HOST_ICONS;
  window.encoreLogoSVG = encoreLogoSVG;
  window.resolveHostIcon = resolveHostIcon;
  window.hostIconSVG = hostIconSVG;
  window.hostIconBadge = hostIconBadge;
})();
