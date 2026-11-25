package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type NotifyConfig struct {
	Enabled                bool     `json:"enabled"`
	SMTPHost               string   `json:"smtp_host"`
	SMTPPort               int      `json:"smtp_port"`
	SMTPTLS                string   `json:"smtp_tls"` // "starttls", "tls", "none"
	SMTPInsecureTLS        bool     `json:"smtp_insecure_tls"`
	SMTPUser               string   `json:"smtp_user"`
	SMTPPass               string   `json:"smtp_pass"`
	FromAddress            string   `json:"from_address"`
	FromName               string   `json:"from_name"`
	Recipients             []string `json:"recipients"`
	IncludeManagedContacts bool     `json:"include_managed_contacts"`
	NotifyDown             bool     `json:"notify_down"`
	NotifyCritical         bool     `json:"notify_critical"`
	NotifyWarning          bool     `json:"notify_warning"`
	NotifyRecovery         bool     `json:"notify_recovery"`
	HardOnly               bool     `json:"hard_only"`
	CooldownMin            int      `json:"cooldown_min"`
	DashboardURL           string   `json:"dashboard_url"`

	// Optional Webhook channel (Telegram / Slack / Discord / Generic)
	WebhookEnabled bool   `json:"webhook_enabled"`
	WebhookType    string `json:"webhook_type"` // "generic", "telegram", "slack", "discord"
	WebhookURL     string `json:"webhook_url"`
	WebhookChatID  string `json:"webhook_chat_id,omitempty"`

	// Hostgroup-specific routing rules (optional)
	Routes []NotifyRoute `json:"routes,omitempty"`
}

type NotifyRoute struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Hostgroup      string   `json:"hostgroup"` // e.g. "db-prod" or "*"
	Recipients     []string `json:"recipients,omitempty"`
	WebhookEnabled bool     `json:"webhook_enabled"`
	WebhookType    string   `json:"webhook_type,omitempty"`
	WebhookURL     string   `json:"webhook_url,omitempty"`
	WebhookChatID  string   `json:"webhook_chat_id,omitempty"`
	Enabled        bool     `json:"enabled"`
}

type NotifyDelivery struct {
	Time    string `json:"time"`
	Channel string `json:"channel"` // "email" or "webhook"
	Target  string `json:"target"`
	Subject string `json:"subject"`
	Status  string `json:"status"` // "sent" or "failed"
	Error   string `json:"error,omitempty"`
}

type AlertEvent struct {
	Kind      string // "host" or "service"
	Host      string
	Service   string
	State     string
	PrevState string
	Output    string
	Time      time.Time
}

type Notifier struct {
	mu          sync.RWMutex
	cfgPath     string
	historyPath string
	cs          *ConfigStore
	store       *StateStore
	cfg         NotifyConfig
	lastSent    map[string]time.Time
	history     []NotifyDelivery
	queue       chan AlertEvent
	httpClient  *http.Client
}

func (n *Notifier) SetStore(s *StateStore) {
	n.mu.Lock()
	n.store = s
	n.mu.Unlock()
}

func defaultNotifyConfig() NotifyConfig {
	return NotifyConfig{
		Enabled:                false,
		SMTPPort:               587,
		SMTPTLS:                "starttls",
		FromName:               "Encore Monitor",
		Recipients:             []string{},
		IncludeManagedContacts: true,
		NotifyDown:             true,
		NotifyCritical:         true,
		NotifyWarning:          false,
		NotifyRecovery:         true,
		HardOnly:               true,
		CooldownMin:            10,
		WebhookType:            "generic",
	}
}

func NewNotifier(managedDir string, cs *ConfigStore) *Notifier {
	n := &Notifier{
		cs:         cs,
		cfg:        defaultNotifyConfig(),
		lastSent:   make(map[string]time.Time),
		history:    []NotifyDelivery{},
		queue:      make(chan AlertEvent, 128),
		httpClient: &http.Client{Timeout: 8 * time.Second},
	}
	if managedDir != "" {
		n.cfgPath = filepath.Join(managedDir, "encore-notify.json")
		n.historyPath = filepath.Join(managedDir, "encore-notify-history.json")
		if raw, err := os.ReadFile(n.historyPath); err == nil && len(raw) > 0 {
			var loadedHist []NotifyDelivery
			if json.Unmarshal(raw, &loadedHist) == nil && loadedHist != nil {
				n.history = loadedHist
			}
		}
		if raw, err := os.ReadFile(n.cfgPath); err == nil && len(raw) > 0 {
			var loaded NotifyConfig
			if json.Unmarshal(raw, &loaded) == nil {
				if loaded.SMTPPort == 0 {
					loaded.SMTPPort = 587
				}
				if loaded.SMTPTLS == "" {
					loaded.SMTPTLS = "starttls"
				}
				if loaded.FromName == "" {
					loaded.FromName = "Encore Monitor"
				}
				if loaded.Recipients == nil {
					loaded.Recipients = []string{}
				}
				if loaded.WebhookType == "" {
					loaded.WebhookType = "generic"
				}
				n.cfg = loaded
			}
		}
	}
	go n.worker()
	return n
}

func maskWebhookURL(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	if len(u) <= 24 {
		return "••••••••"
	}
	return u[:16] + "••••••••" + u[len(u)-4:]
}

func sanitizeSMTPHeader(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}

func (n *Notifier) ConfigMasked() NotifyConfig {
	n.mu.RLock()
	defer n.mu.RUnlock()
	c := n.cfg
	if c.SMTPPass != "" {
		c.SMTPPass = "••••••••"
	}
	if c.WebhookURL != "" {
		c.WebhookURL = maskWebhookURL(c.WebhookURL)
	}
	if len(c.Routes) > 0 {
		routes := make([]NotifyRoute, len(c.Routes))
		copy(routes, c.Routes)
		for i := range routes {
			if routes[i].WebhookURL != "" {
				routes[i].WebhookURL = maskWebhookURL(routes[i].WebhookURL)
			}
		}
		c.Routes = routes
	}
	return c
}

func (n *Notifier) UpdateConfig(in NotifyConfig) error {
	if in.SMTPPort <= 0 {
		in.SMTPPort = 587
	}
	if in.SMTPTLS == "" {
		in.SMTPTLS = "starttls"
	}
	if in.FromName == "" {
		in.FromName = "Encore Monitor"
	}
	if in.CooldownMin < 0 {
		in.CooldownMin = 0
	}
	if in.WebhookType == "" {
		in.WebhookType = "generic"
	}
	cleaned := make([]string, 0, len(in.Recipients))
	for _, r := range in.Recipients {
		r = strings.TrimSpace(r)
		if r != "" {
			cleaned = append(cleaned, r)
		}
	}
	in.Recipients = cleaned

	n.mu.Lock()
	// Keep existing password/webhook URLs if UI sent masked values back unchanged
	if in.SMTPPass == "••••••••" || (in.SMTPPass == "" && n.cfg.SMTPPass != "" && in.SMTPHost == n.cfg.SMTPHost && in.SMTPUser == n.cfg.SMTPUser) {
		in.SMTPPass = n.cfg.SMTPPass
	}
	if strings.Contains(in.WebhookURL, "••••••••") {
		in.WebhookURL = n.cfg.WebhookURL
	}
	if len(in.Routes) > 0 && len(n.cfg.Routes) > 0 {
		oldByID := make(map[string]string, len(n.cfg.Routes))
		for _, r := range n.cfg.Routes {
			if r.ID != "" {
				oldByID[r.ID] = r.WebhookURL
			}
		}
		for i := range in.Routes {
			if strings.Contains(in.Routes[i].WebhookURL, "••••••••") {
				if orig, ok := oldByID[in.Routes[i].ID]; ok {
					in.Routes[i].WebhookURL = orig
				}
			}
		}
	}
	n.cfg = in
	path := n.cfgPath
	n.mu.Unlock()

	if path != "" {
		raw, err := json.MarshalIndent(in, "", "  ")
		if err != nil {
			return err
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, raw, 0o600); err != nil {
			return err
		}
		if err := os.Rename(tmp, path); err != nil {
			return err
		}
	}
	if n.cs != nil {
		n.cs.RecordAudit("notify_config", "smtp/webhook", fmt.Sprintf("email=%v webhook=%v", in.Enabled, in.WebhookEnabled))
	}
	return nil
}

func (n *Notifier) History() []NotifyDelivery {
	n.mu.RLock()
	defer n.mu.RUnlock()
	out := make([]NotifyDelivery, len(n.history))
	copy(out, n.history)
	return out
}

func (n *Notifier) recordDelivery(d NotifyDelivery) {
	n.mu.Lock()
	n.history = append([]NotifyDelivery{d}, n.history...)
	if len(n.history) > 50 {
		n.history = n.history[:50]
	}
	hPath := n.historyPath
	var raw []byte
	if hPath != "" {
		raw, _ = json.Marshal(n.history)
	}
	n.mu.Unlock()
	if hPath != "" && len(raw) > 0 {
		_ = os.WriteFile(hPath+".tmp", raw, 0o600)
		_ = os.Rename(hPath+".tmp", hPath)
	}
	if n.cs != nil {
		n.cs.RecordAudit("notify_"+d.Status, d.Channel+":"+d.Target, d.Subject)
	}
}

func hostStateLabel(st int) string {
	switch st {
	case 0:
		return "UP"
	case 1:
		return "DOWN"
	case 2:
		return "UNREACHABLE"
	default:
		return "UNKNOWN"
	}
}

func svcStateLabel(st int) string {
	switch st {
	case 0:
		return "OK"
	case 1:
		return "WARNING"
	case 2:
		return "CRITICAL"
	default:
		return "UNKNOWN"
	}
}

func (n *Notifier) OnHostTransition(prev *HostState, next HostState) {
	if n == nil || prev == nil || prev.HasBeenChecked == 0 || next.HasBeenChecked == 0 {
		return
	}
	if next.DowntimeDepth > 0 || next.Acknowledged > 0 {
		return
	}
	n.mu.RLock()
	cfg := n.cfg
	n.mu.RUnlock()
	if !cfg.Enabled && !cfg.WebhookEnabled {
		return
	}

	isRecov := false
	if cfg.HardOnly {
		if next.StateType != 1 {
			return
		}
		if next.CurrentState == 0 {
			// Send RECOVERY only if it was previously in a HARD problem state
			if prev.CurrentState == 0 || prev.StateType != 1 {
				return
			}
			isRecov = true
		} else {
			// Send HARD problem alert when entering HARD problem (from OK/other state OR from SOFT)
			if prev.CurrentState == next.CurrentState && prev.StateType == 1 {
				return
			}
		}
	} else {
		if prev.CurrentState == next.CurrentState {
			return
		}
		isRecov = next.CurrentState == 0 && prev.CurrentState > 0
	}

	if isRecov && !cfg.NotifyRecovery {
		return
	}
	if !isRecov && !cfg.NotifyDown {
		return
	}
	n.enqueue(AlertEvent{
		Kind:      "host",
		Host:      next.Name,
		State:     hostStateLabel(next.CurrentState),
		PrevState: hostStateLabel(prev.CurrentState),
		Output:    next.PluginOutput,
		Time:      time.Now(),
	}, cfg.CooldownMin, isRecov)
}

func (n *Notifier) OnServiceTransition(prev *ServiceState, next ServiceState) {
	if n == nil || prev == nil || prev.HasBeenChecked == 0 || next.HasBeenChecked == 0 {
		return
	}
	if next.DowntimeDepth > 0 || next.Acknowledged > 0 {
		return
	}
	n.mu.RLock()
	cfg := n.cfg
	n.mu.RUnlock()
	if !cfg.Enabled && !cfg.WebhookEnabled {
		return
	}

	isRecov := false
	if cfg.HardOnly {
		if next.StateType != 1 {
			return
		}
		if next.CurrentState == 0 {
			// Send RECOVERY only if it was previously in a HARD problem state
			if prev.CurrentState == 0 || prev.StateType != 1 {
				return
			}
			isRecov = true
		} else {
			// Send HARD problem alert when entering HARD problem (from OK/other state OR from SOFT)
			if prev.CurrentState == next.CurrentState && prev.StateType == 1 {
				return
			}
		}
	} else {
		if prev.CurrentState == next.CurrentState {
			return
		}
		isRecov = next.CurrentState == 0 && prev.CurrentState > 0
	}

	switch {
	case isRecov:
		if !cfg.NotifyRecovery {
			return
		}
	case next.CurrentState == 1:
		if !cfg.NotifyWarning {
			return
		}
	case next.CurrentState >= 2:
		if !cfg.NotifyCritical {
			return
		}
	}
	n.enqueue(AlertEvent{
		Kind:      "service",
		Host:      next.HostName,
		Service:   next.Description,
		State:     svcStateLabel(next.CurrentState),
		PrevState: svcStateLabel(prev.CurrentState),
		Output:    next.PluginOutput,
		Time:      time.Now(),
	}, cfg.CooldownMin, isRecov)
}

func (n *Notifier) enqueue(ev AlertEvent, cooldownMin int, isRecov bool) {
	key := ev.Kind + ":" + ev.Host + ":" + ev.Service
	if !isRecov && cooldownMin > 0 {
		n.mu.Lock()
		if last, ok := n.lastSent[key]; ok && time.Since(last) < time.Duration(cooldownMin)*time.Minute {
			n.mu.Unlock()
			return
		}
		n.lastSent[key] = time.Now()
		n.mu.Unlock()
	}
	select {
	case n.queue <- ev:
	default:
		log.Printf("[notify] queue full, dropping alert for %s", key)
	}
}

func (n *Notifier) worker() {
	for ev := range n.queue {
		n.dispatch(ev)
	}
}

func (n *Notifier) resolveRecipients(cfg NotifyConfig) []string {
	seen := make(map[string]bool)
	var out []string
	add := func(addr string) {
		addr = strings.TrimSpace(addr)
		if addr == "" || !strings.Contains(addr, "@") {
			return
		}
		low := strings.ToLower(addr)
		if !seen[low] {
			seen[low] = true
			out = append(out, addr)
		}
	}
	for _, r := range cfg.Recipients {
		add(r)
	}
	if cfg.IncludeManagedContacts && n.cs != nil {
		mcfg, _, _ := n.cs.Snapshot()
		for _, ct := range mcfg.Contacts {
			add(ct.Email)
		}
	}
	return out
}

func alertStateMeta(ev AlertEvent) (emoji, label string) {
	if ev.PrevState == "TEST" {
		return "🧪", "TEST"
	}
	switch strings.ToUpper(ev.State) {
	case "OK", "UP":
		return "✅", "RESOLVED"
	case "CRITICAL", "DOWN":
		return "🚨", strings.ToUpper(ev.State)
	case "WARNING", "UNREACHABLE":
		return "⚠️", strings.ToUpper(ev.State)
	case "DIGEST":
		return "📊", "SLA DIGEST"
	default:
		return "❓", strings.ToUpper(ev.State)
	}
}

func formatAlertSubject(ev AlertEvent) string {
	target := ev.Host
	if ev.Service != "" {
		target = ev.Host + " / " + ev.Service
	}
	emoji, label := alertStateMeta(ev)
	return fmt.Sprintf("%s [Encore %s] %s", emoji, label, target)
}

func formatAlertHTML(ev AlertEvent, dashURL string) string {
	color := "#ef4444"
	if ev.State == "OK" || ev.State == "UP" {
		color = "#10b981"
	} else if ev.State == "WARNING" || ev.State == "UNREACHABLE" {
		color = "#f59e0b"
	}
	target := html.EscapeString(ev.Host)
	if ev.Service != "" {
		target += " / " + html.EscapeString(ev.Service)
	}
	linkHTML := ""
	if dashURL != "" {
		linkHTML = fmt.Sprintf(`<p style="margin-top:16px"><a href="%s" style="display:inline-block;padding:8px 16px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Open Encore Dashboard</a></p>`, html.EscapeString(dashURL))
	}
	return fmt.Sprintf(`<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f8fafc;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
  <div style="background:%s;color:#ffffff;padding:14px 18px;font-weight:700;font-size:15px">%s — %s</div>
  <div style="padding:18px;font-size:13.5px;line-height:1.5">
    <p style="margin:0 0 8px"><b>Target:</b> %s</p>
    <p style="margin:0 0 8px"><b>Transition:</b> %s &rarr; <b>%s</b></p>
    <p style="margin:0 0 8px"><b>Time:</b> %s</p>
    <div style="background:#f1f5f9;border-radius:6px;padding:10px 12px;font-family:monospace;font-size:12.5px;margin-top:10px">%s</div>
    %s
  </div>
</div></body></html>`,
		color,
		html.EscapeString(ev.State),
		target,
		target,
		html.EscapeString(ev.PrevState),
		html.EscapeString(ev.State),
		ev.Time.Format("2006-01-02 15:04:05 MST"),
		html.EscapeString(ev.Output),
		linkHTML,
	)
}

func (n *Notifier) dispatch(ev AlertEvent) {
	n.mu.RLock()
	cfg := n.cfg
	st := n.store
	n.mu.RUnlock()

	subj := formatAlertSubject(ev)

	// Check hostgroup-specific routing rules first
	var matchedRoutes []NotifyRoute
	if len(cfg.Routes) > 0 {
		hgs := map[string]bool{}
		if st != nil {
			hgs = st.HostGroupsOf(ev.Host)
		}
		for _, rt := range cfg.Routes {
			if !rt.Enabled {
				continue
			}
			if rt.Hostgroup == "*" || hgs[rt.Hostgroup] {
				matchedRoutes = append(matchedRoutes, rt)
			}
		}
	}

	if len(matchedRoutes) > 0 {
		for _, rt := range matchedRoutes {
			if cfg.Enabled && len(rt.Recipients) > 0 {
				err := sendSMTPEmail(cfg, rt.Recipients, subj, formatAlertHTML(ev, cfg.DashboardURL))
				d := NotifyDelivery{Time: time.Now().UTC().Format(time.RFC3339), Channel: "email:" + rt.Name, Target: strings.Join(rt.Recipients, ", "), Subject: subj, Status: "sent"}
				if err != nil {
					d.Status = "failed"
					d.Error = err.Error()
				}
				n.recordDelivery(d)
			}
			if rt.WebhookEnabled && rt.WebhookURL != "" {
				rtCfg := cfg
				rtCfg.WebhookType = rt.WebhookType
				rtCfg.WebhookURL = rt.WebhookURL
				rtCfg.WebhookChatID = rt.WebhookChatID
				err := n.sendWebhook(rtCfg, ev, subj)
				d := NotifyDelivery{Time: time.Now().UTC().Format(time.RFC3339), Channel: "webhook:" + rt.Name, Target: ev.Host, Subject: subj, Status: "sent"}
				if err != nil {
					d.Status = "failed"
					d.Error = err.Error()
				}
				n.recordDelivery(d)
			}
		}
		return
	}

	if cfg.Enabled {
		recips := n.resolveRecipients(cfg)
		if len(recips) > 0 {
			err := sendSMTPEmail(cfg, recips, subj, formatAlertHTML(ev, cfg.DashboardURL))
			d := NotifyDelivery{
				Time:    time.Now().UTC().Format(time.RFC3339),
				Channel: "email",
				Target:  strings.Join(recips, ", "),
				Subject: subj,
				Status:  "sent",
			}
			if err != nil {
				d.Status = "failed"
				d.Error = err.Error()
				log.Printf("[notify] email failed: %v", err)
			}
			n.recordDelivery(d)
		}
	}

	if cfg.WebhookEnabled && cfg.WebhookURL != "" {
		err := n.sendWebhook(cfg, ev, subj)
		d := NotifyDelivery{
			Time:    time.Now().UTC().Format(time.RFC3339),
			Channel: "webhook:" + cfg.WebhookType,
			Target:  ev.Host,
			Subject: subj,
			Status:  "sent",
		}
		if err != nil {
			d.Status = "failed"
			d.Error = err.Error()
			log.Printf("[notify] webhook failed: %v", err)
		}
		n.recordDelivery(d)
	}
}

func sendSMTPEmail(cfg NotifyConfig, to []string, subject, htmlBody string) error {
	if strings.TrimSpace(cfg.SMTPHost) == "" {
		return errors.New("smtp_host is required")
	}
	if strings.TrimSpace(cfg.FromAddress) == "" {
		return errors.New("from_address is required")
	}
	if len(to) == 0 {
		return errors.New("at least one recipient email is required")
	}

	addr := fmt.Sprintf("%s:%d", cfg.SMTPHost, cfg.SMTPPort)
	tlsCfg := &tls.Config{ServerName: cfg.SMTPHost, InsecureSkipVerify: cfg.SMTPInsecureTLS}

	var client *smtp.Client
	var err error

	if strings.EqualFold(cfg.SMTPTLS, "tls") {
		conn, derr := tls.DialWithDialer(&net.Dialer{Timeout: 8 * time.Second}, "tcp", addr, tlsCfg)
		if derr != nil {
			return fmt.Errorf("tls dial %s: %w", addr, derr)
		}
		client, err = smtp.NewClient(conn, cfg.SMTPHost)
	} else {
		conn, derr := net.DialTimeout("tcp", addr, 8*time.Second)
		if derr != nil {
			return fmt.Errorf("tcp dial %s: %w", addr, derr)
		}
		client, err = smtp.NewClient(conn, cfg.SMTPHost)
		if err == nil && strings.EqualFold(cfg.SMTPTLS, "starttls") {
			if ok, _ := client.Extension("STARTTLS"); ok {
				if terr := client.StartTLS(tlsCfg); terr != nil {
					_ = client.Close()
					return fmt.Errorf("starttls: %w", terr)
				}
			}
		}
	}
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer client.Close()

	if cfg.SMTPUser != "" {
		auth := smtp.PlainAuth("", cfg.SMTPUser, cfg.SMTPPass, cfg.SMTPHost)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}

	if err := client.Mail(cfg.FromAddress); err != nil {
		return fmt.Errorf("mail from: %w", err)
	}
	for _, rcpt := range to {
		if err := client.Rcpt(rcpt); err != nil {
			return fmt.Errorf("rcpt to %s: %w", rcpt, err)
		}
	}

	wc, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	fromHeader := sanitizeSMTPHeader(cfg.FromAddress)
	if cfg.FromName != "" {
		fromHeader = fmt.Sprintf("%s <%s>", sanitizeSMTPHeader(cfg.FromName), sanitizeSMTPHeader(cfg.FromAddress))
	}
	safeTo := make([]string, len(to))
	for i, r := range to {
		safeTo[i] = sanitizeSMTPHeader(r)
	}
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nDate: %s\r\n\r\n%s",
		fromHeader,
		strings.Join(safeTo, ", "),
		sanitizeSMTPHeader(subject),
		time.Now().Format(time.RFC1123Z),
		htmlBody,
	)
	if _, err := wc.Write([]byte(msg)); err != nil {
		_ = wc.Close()
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	_ = client.Quit()
	return nil
}

func formatWebhookText(ev AlertEvent, dashURL string, htmlMode bool) string {
	emoji, label := alertStateMeta(ev)
	target := ev.Host
	if ev.Service != "" {
		target += " / " + ev.Service
	}
	ts := ev.Time.Format("2006-01-02 15:04:05 MST")
	out := strings.TrimSpace(ev.Output)
	if out == "" {
		out = "-"
	}

	if htmlMode {
		var b strings.Builder
		fmt.Fprintf(&b, "%s <b>%s</b> — %s\n\n", emoji, html.EscapeString(label), html.EscapeString(target))
		fmt.Fprintf(&b, "<b>Host:</b> <code>%s</code>\n", html.EscapeString(ev.Host))
		if ev.Service != "" {
			fmt.Fprintf(&b, "<b>Service:</b> <code>%s</code>\n", html.EscapeString(ev.Service))
		}
		fmt.Fprintf(&b, "<b>Status:</b> %s → <b>%s</b>\n", html.EscapeString(ev.PrevState), html.EscapeString(ev.State))
		fmt.Fprintf(&b, "<b>Time:</b> %s\n\n", html.EscapeString(ts))
		fmt.Fprintf(&b, "<b>Output:</b>\n<code>%s</code>", html.EscapeString(out))
		if dashURL != "" {
			fmt.Fprintf(&b, "\n\n🔗 <a href=\"%s\">Open Encore Dashboard</a>", html.EscapeString(dashURL))
		}
		return b.String()
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s **%s** — %s\n\n", emoji, label, target)
	fmt.Fprintf(&b, "Host: %s\n", ev.Host)
	if ev.Service != "" {
		fmt.Fprintf(&b, "Service: %s\n", ev.Service)
	}
	fmt.Fprintf(&b, "Status: %s → %s\n", ev.PrevState, ev.State)
	fmt.Fprintf(&b, "Time: %s\n\n", ts)
	fmt.Fprintf(&b, "Output:\n%s", out)
	if dashURL != "" {
		fmt.Fprintf(&b, "\n\n🔗 Dashboard: %s", dashURL)
	}
	return b.String()
}

func (n *Notifier) sendWebhook(cfg NotifyConfig, ev AlertEvent, subject string) error {
	u := strings.TrimSpace(cfg.WebhookURL)
	if u == "" {
		return errors.New("webhook_url is required")
	}
	if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return errors.New("webhook_url must start with http:// or https://")
	}

	var payload any
	switch strings.ToLower(cfg.WebhookType) {
	case "slack":
		payload = map[string]any{"text": formatWebhookText(ev, cfg.DashboardURL, false)}
	case "discord":
		payload = map[string]any{"content": formatWebhookText(ev, cfg.DashboardURL, false)}
	case "telegram":
		payload = map[string]any{
			"chat_id":                  cfg.WebhookChatID,
			"text":                     formatWebhookText(ev, cfg.DashboardURL, true),
			"parse_mode":               "HTML",
			"disable_web_page_preview": true,
		}
	default:
		payload = map[string]any{
			"subject":    subject,
			"kind":       ev.Kind,
			"host":       ev.Host,
			"service":    ev.Service,
			"state":      ev.State,
			"prev_state": ev.PrevState,
			"output":     ev.Output,
			"timestamp":  ev.Time.Unix(),
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := n.httpClient.Post(u, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("webhook HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

func registerNotifyRoutes(mux *http.ServeMux, notifier *Notifier) {
	mux.HandleFunc("/api/v1/notifications/config", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{
				"config":  notifier.ConfigMasked(),
				"history": notifier.History(),
			})
		case http.MethodPost, http.MethodPut:
			var cfg NotifyConfig
			if err := decodeJSONBody(r, &cfg); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := notifier.UpdateConfig(cfg); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "config": notifier.ConfigMasked()})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/notifications/test", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			Channel string `json:"channel"` // "email" or "webhook"
			To      string `json:"to"`
		}
		_ = decodeJSONBody(r, &req)
		if req.Channel == "" {
			req.Channel = "email"
		}

		notifier.mu.RLock()
		cfg := notifier.cfg
		notifier.mu.RUnlock()

		ev := AlertEvent{
			Kind:      "service",
			Host:      "encore-server",
			Service:   "Notification Test",
			State:     "OK",
			PrevState: "TEST",
			Output:    "This is a test notification from Encore Monitoring Console.",
			Time:      time.Now(),
		}
		subj := "[Encore TEST] Notification delivery verified"

		if req.Channel == "webhook" {
			if err := notifier.sendWebhook(cfg, ev, subj); err != nil {
				notifier.recordDelivery(NotifyDelivery{Time: time.Now().UTC().Format(time.RFC3339), Channel: "webhook:" + cfg.WebhookType, Target: "test", Subject: subj, Status: "failed", Error: err.Error()})
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
				return
			}
			notifier.recordDelivery(NotifyDelivery{Time: time.Now().UTC().Format(time.RFC3339), Channel: "webhook:" + cfg.WebhookType, Target: "test", Subject: subj, Status: "sent"})
			writeJSON(w, http.StatusOK, map[string]string{"status": "sent", "channel": "webhook"})
			return
		}

		recips := notifier.resolveRecipients(cfg)
		if strings.TrimSpace(req.To) != "" {
			recips = []string{strings.TrimSpace(req.To)}
		}
		if err := sendSMTPEmail(cfg, recips, subj, formatAlertHTML(ev, cfg.DashboardURL)); err != nil {
			notifier.recordDelivery(NotifyDelivery{Time: time.Now().UTC().Format(time.RFC3339), Channel: "email", Target: strings.Join(recips, ","), Subject: subj, Status: "failed", Error: err.Error()})
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		notifier.recordDelivery(NotifyDelivery{Time: time.Now().UTC().Format(time.RFC3339), Channel: "email", Target: strings.Join(recips, ","), Subject: subj, Status: "sent"})
		writeJSON(w, http.StatusOK, map[string]any{"status": "sent", "channel": "email", "recipients": recips})
	})

	mux.HandleFunc("/api/v1/notifications/history", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"history": notifier.History()})
	})
}
