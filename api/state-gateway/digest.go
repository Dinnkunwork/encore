package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type DigestConfig struct {
	Enabled      bool   `json:"enabled"`
	Frequency    string `json:"frequency"`     // "daily" or "weekly"
	DayOfWeek    int    `json:"day_of_week"`   // 0=Sun..6=Sat (used for weekly)
	SendTime     string `json:"send_time"`     // "HH:MM" 24h
	WindowDays   int    `json:"window_days"`   // 1, 7, or 30
	Hostgroup    string `json:"hostgroup"`     // optional filter
	SendEmail    bool   `json:"send_email"`
	SendWebhook  bool   `json:"send_webhook"`
	LastSentDate string `json:"last_sent_date,omitempty"`
}

type DigestManager struct {
	mu          sync.Mutex
	filePath    string
	store       *StateStore
	notifier    *Notifier
	cs          *ConfigStore
	logPath     string
	archivesDir string
	cfg         DigestConfig
}

func NewDigestManager(managedDir, logPath, archivesDir string, store *StateStore, notifier *Notifier, cs *ConfigStore) *DigestManager {
	dm := &DigestManager{
		store:       store,
		notifier:    notifier,
		cs:          cs,
		logPath:     logPath,
		archivesDir: archivesDir,
		cfg: DigestConfig{
			Enabled:     false,
			Frequency:   "weekly",
			DayOfWeek:   1, // Monday
			SendTime:    "08:00",
			WindowDays:  7,
			SendEmail:   true,
			SendWebhook: false,
		},
	}
	if managedDir != "" {
		dm.filePath = filepath.Join(managedDir, "encore-digest.json")
		if raw, err := os.ReadFile(dm.filePath); err == nil && len(raw) > 0 {
			var loaded DigestConfig
			if json.Unmarshal(raw, &loaded) == nil {
				dm.cfg = loaded
			}
		}
	}
	return dm
}

func (dm *DigestManager) GetConfig() DigestConfig {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	return dm.cfg
}

func (dm *DigestManager) UpdateConfig(in DigestConfig, actor string) error {
	if in.Frequency != "daily" && in.Frequency != "weekly" {
		in.Frequency = "weekly"
	}
	if in.DayOfWeek < 0 || in.DayOfWeek > 6 {
		in.DayOfWeek = 1
	}
	if _, err := time.Parse("15:04", in.SendTime); err != nil {
		return errors.New("send_time must be HH:MM (24h)")
	}
	if in.WindowDays <= 0 || in.WindowDays > 90 {
		in.WindowDays = 7
	}

	dm.mu.Lock()
	in.LastSentDate = dm.cfg.LastSentDate
	dm.cfg = in
	path := dm.filePath
	dm.mu.Unlock()

	if path != "" {
		raw, err := json.MarshalIndent(in, "", "  ")
		if err != nil {
			return err
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, raw, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, path); err != nil {
			return err
		}
	}
	if dm.cs != nil {
		dm.cs.RecordAudit("digest_config", fmt.Sprintf("%s@%s (%dd)", in.Frequency, in.SendTime, in.WindowDays), "by="+actor)
	}
	return nil
}

func (dm *DigestManager) SendNow(actor string) (string, error) {
	if dm.notifier == nil {
		return "", errors.New("notifier not configured")
	}
	cfg := dm.GetConfig()
	if !cfg.SendEmail && !cfg.SendWebhook {
		return "", errors.New("enable at least Email or Webhook delivery for digest")
	}

	now := time.Now()
	toTS := now.Unix()
	fromTS := toTS - int64(cfg.WindowDays)*86400
	sum, rows, _ := computeAvailability(dm.store, dm.logPath, dm.archivesDir, fromTS, toTS, "services", cfg.Hostgroup, "", "")

	scope := "All Infrastructure"
	if cfg.Hostgroup != "" {
		scope = "Hostgroup: " + cfg.Hostgroup
	}
	subj := fmt.Sprintf("[Encore SLA Digest] %.2f%% SLA • %d Incidents (%dd — %s)", sum.OverallSLAPct, sum.TotalIncidents, cfg.WindowDays, scope)

	// Format clean HTML report for email
	var b strings.Builder
	fmt.Fprintf(&b, `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f8fafc;padding:20px">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
  <div style="background:#0f172a;color:#ffffff;padding:16px 20px">
    <div style="font-size:16px;font-weight:700">Encore SLA Report Digest (%d Days)</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:2px">%s • %s to %s</div>
  </div>
  <div style="padding:18px 20px">
    <table style="width:100%%;border-collapse:collapse;margin-bottom:14px">
      <tr>
        <td style="padding:10px;background:#f1f5f9;border-radius:6px;text-align:center"><div style="font-size:11px;color:#64748b">OVERALL SLA</div><div style="font-size:20px;font-weight:700;color:#047857">%.2f%%</div></td>
        <td style="width:8px"></td>
        <td style="padding:10px;background:#f1f5f9;border-radius:6px;text-align:center"><div style="font-size:11px;color:#64748b">HARD INCIDENTS</div><div style="font-size:20px;font-weight:700;color:#b91c1c">%d</div></td>
        <td style="width:8px"></td>
        <td style="padding:10px;background:#f1f5f9;border-radius:6px;text-align:center"><div style="font-size:11px;color:#64748b">AVG MTTR</div><div style="font-size:20px;font-weight:700">%.0fs</div></td>
      </tr>
    </table>
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">Lowest Availability Services (Top 10)</div>
    <table style="width:100%%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0"><th style="padding:6px;text-align:left">Host / Service</th><th style="padding:6px;text-align:right">OK %%</th><th style="padding:6px;text-align:right">Incidents</th></tr></thead><tbody>`,
		cfg.WindowDays, html.EscapeString(scope),
		time.Unix(fromTS, 0).Format("2006-01-02"), time.Unix(toTS, 0).Format("2006-01-02"),
		sum.OverallSLAPct, sum.TotalIncidents, sum.AvgMTTRSec)
	limit := len(rows)
	if limit > 10 {
		limit = 10
	}
	for i := 0; i < limit; i++ {
		r := rows[i]
		fmt.Fprintf(&b, `<tr style="border-bottom:1px solid #f1f5f9"><td style="padding:6px"><b>%s</b> / %s</td><td style="padding:6px;text-align:right;font-family:monospace">%.2f%%</td><td style="padding:6px;text-align:right;font-family:monospace">%d</td></tr>`,
			html.EscapeString(r.Host), html.EscapeString(r.Service), r.OKPct, r.Incidents)
	}
	b.WriteString(`</tbody></table></div></div></body></html>`)

	dm.notifier.mu.RLock()
	ncfg := dm.notifier.cfg
	dm.notifier.mu.RUnlock()

	var sentChannels []string
	if cfg.SendEmail {
		recips := dm.notifier.resolveRecipients(ncfg)
		if err := sendSMTPEmail(ncfg, recips, subj, b.String()); err != nil {
			return "", fmt.Errorf("email digest failed: %w", err)
		}
		sentChannels = append(sentChannels, fmt.Sprintf("email(%d)", len(recips)))
	}
	if cfg.SendWebhook {
		textSummary := fmt.Sprintf("Scope: %s (%dd)\nOverall SLA: %.2f%% | Objects: %d | HARD Incidents: %d | Avg MTTR: %.0fs",
			scope, cfg.WindowDays, sum.OverallSLAPct, sum.TotalObjects, sum.TotalIncidents, sum.AvgMTTRSec)
		ev := AlertEvent{Kind: "digest", Host: scope, State: "DIGEST", PrevState: "SLA", Output: textSummary, Time: now}
		if err := dm.notifier.sendWebhook(ncfg, ev, subj); err != nil {
			return "", fmt.Errorf("webhook digest failed: %w", err)
		}
		sentChannels = append(sentChannels, "webhook:"+ncfg.WebhookType)
	}

	if dm.cs != nil {
		dm.cs.RecordAudit("digest_sent", strings.Join(sentChannels, ", "), fmt.Sprintf("sla=%.2f%% by=%s", sum.OverallSLAPct, actor))
	}
	return strings.Join(sentChannels, ", "), nil
}

func (dm *DigestManager) Tick(now time.Time) {
	cfg := dm.GetConfig()
	if !cfg.Enabled {
		return
	}
	today := now.Format("2006-01-02")
	if cfg.LastSentDate == today || now.Format("15:04") != cfg.SendTime {
		return
	}
	if cfg.Frequency == "weekly" && int(now.Weekday()) != cfg.DayOfWeek {
		return
	}
	dm.mu.Lock()
	dm.cfg.LastSentDate = today
	path := dm.filePath
	raw, _ := json.MarshalIndent(dm.cfg, "", "  ")
	dm.mu.Unlock()
	if path != "" {
		_ = os.WriteFile(path+".tmp", raw, 0o644)
		_ = os.Rename(path+".tmp", path)
	}
	_, _ = dm.SendNow("encore-scheduler")
}

func (dm *DigestManager) RunLoop(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			dm.Tick(now)
		}
	}
}

func registerDigestRoutes(mux *http.ServeMux, dm *DigestManager) {
	mux.HandleFunc("/api/v1/reports/digest", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"config": dm.GetConfig()})
		case http.MethodPost, http.MethodPut:
			var cfg DigestConfig
			if err := decodeJSONBody(r, &cfg); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := dm.UpdateConfig(cfg, actorFromRequest(r)); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "config": dm.GetConfig()})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/reports/digest/send-now", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		channels, err := dm.SendNow(actorFromRequest(r))
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "sent", "channels": channels})
	})
}
