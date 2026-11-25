package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type RecurringDowntime struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	TargetType  string `json:"target_type"` // "host", "service", "hostgroup"
	Host        string `json:"host,omitempty"`
	Service     string `json:"service,omitempty"`
	Hostgroup   string `json:"hostgroup,omitempty"`
	Days        []int  `json:"days"`       // 0=Sun..6=Sat
	StartTime   string `json:"start_time"` // "HH:MM"
	DurationMin int    `json:"duration_min"`
	Comment     string `json:"comment"`
	Enabled     bool   `json:"enabled"`
	LastRunDate string `json:"last_run_date,omitempty"`
}

type RecurringStore struct {
	mu          sync.Mutex
	filePath    string
	cmdPipePath string
	store       *StateStore
	cs          *ConfigStore
	items       []RecurringDowntime
}

func NewRecurringStore(managedDir, cmdPipePath string, store *StateStore, cs *ConfigStore) *RecurringStore {
	rs := &RecurringStore{
		cmdPipePath: cmdPipePath,
		store:       store,
		cs:          cs,
		items:       []RecurringDowntime{},
	}
	if managedDir != "" {
		rs.filePath = filepath.Join(managedDir, "encore-recurring-dt.json")
		if raw, err := os.ReadFile(rs.filePath); err == nil && len(raw) > 0 {
			var loaded []RecurringDowntime
			if json.Unmarshal(raw, &loaded) == nil && loaded != nil {
				rs.items = loaded
			}
		}
	}
	return rs
}

func (rs *RecurringStore) saveLocked() error {
	if rs.filePath == "" {
		return nil
	}
	raw, err := json.MarshalIndent(rs.items, "", "  ")
	if err != nil {
		return err
	}
	tmp := rs.filePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, rs.filePath)
}

func (rs *RecurringStore) List() []RecurringDowntime {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	out := make([]RecurringDowntime, len(rs.items))
	copy(out, rs.items)
	return out
}

func (rs *RecurringStore) Upsert(item RecurringDowntime, actor string) (RecurringDowntime, error) {
	item.Name = strings.TrimSpace(item.Name)
	if item.Name == "" {
		return item, errors.New("schedule name is required")
	}
	if item.DurationMin <= 0 {
		item.DurationMin = 60
	}
	if len(item.Days) == 0 {
		return item, errors.New("select at least one day of week")
	}
	if _, err := time.Parse("15:04", item.StartTime); err != nil {
		return item, errors.New("start_time must be HH:MM (24h)")
	}
	if item.TargetType == "host" && strings.TrimSpace(item.Host) == "" {
		return item, errors.New("host is required")
	}
	if item.TargetType == "service" && (strings.TrimSpace(item.Host) == "" || strings.TrimSpace(item.Service) == "") {
		return item, errors.New("host and service are required")
	}
	if item.TargetType == "hostgroup" && strings.TrimSpace(item.Hostgroup) == "" {
		return item, errors.New("hostgroup is required")
	}
	if item.Comment == "" {
		item.Comment = "Recurring maintenance: " + item.Name
	}
	if item.ID == "" {
		item.ID = "rdt-" + randomTokenHex(4)
	}

	rs.mu.Lock()
	defer rs.mu.Unlock()
	found := false
	for i := range rs.items {
		if rs.items[i].ID == item.ID {
			item.LastRunDate = rs.items[i].LastRunDate
			rs.items[i] = item
			found = true
			break
		}
	}
	if !found {
		rs.items = append(rs.items, item)
	}
	if err := rs.saveLocked(); err != nil {
		return item, err
	}
	if rs.cs != nil {
		rs.cs.RecordAudit("upsert_recurring_dt", item.Name, "by="+actor)
	}
	return item, nil
}

func (rs *RecurringStore) Delete(id, actor string) error {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	next := rs.items[:0]
	removed := false
	for _, it := range rs.items {
		if it.ID == id {
			removed = true
			continue
		}
		next = append(next, it)
	}
	if !removed {
		return errors.New("schedule not found")
	}
	rs.items = next
	if err := rs.saveLocked(); err != nil {
		return err
	}
	if rs.cs != nil {
		rs.cs.RecordAudit("delete_recurring_dt", id, "by="+actor)
	}
	return nil
}

func (rs *RecurringStore) Tick(now time.Time) int {
	if rs == nil || rs.cmdPipePath == "" {
		return 0
	}
	today := now.Format("2006-01-02")
	hhmm := now.Format("15:04")
	wd := int(now.Weekday())

	rs.mu.Lock()
	var due []*RecurringDowntime
	for i := range rs.items {
		it := &rs.items[i]
		if !it.Enabled || it.LastRunDate == today || it.StartTime != hhmm {
			continue
		}
		dayMatch := false
		for _, d := range it.Days {
			if d == wd {
				dayMatch = true
				break
			}
		}
		if dayMatch {
			due = append(due, it)
		}
	}
	if len(due) == 0 {
		rs.mu.Unlock()
		return 0
	}

	var cmds []string
	startTS := now.Unix()
	for _, it := range due {
		endTS := startTS + int64(it.DurationMin)*60
		switch it.TargetType {
		case "host":
			cmds = append(cmds, fmt.Sprintf("SCHEDULE_HOST_DOWNTIME;%s;%d;%d;1;0;0;encore-scheduler;%s", it.Host, startTS, endTS, it.Comment))
		case "service":
			cmds = append(cmds, fmt.Sprintf("SCHEDULE_SVC_DOWNTIME;%s;%s;%d;%d;1;0;0;encore-scheduler;%s", it.Host, it.Service, startTS, endTS, it.Comment))
		case "hostgroup":
			cmds = append(cmds, fmt.Sprintf("SCHEDULE_HOSTGROUP_HOST_DOWNTIME;%s;%d;%d;1;0;0;encore-scheduler;%s", it.Hostgroup, startTS, endTS, it.Comment))
			cmds = append(cmds, fmt.Sprintf("SCHEDULE_HOSTGROUP_SVC_DOWNTIME;%s;%d;%d;1;0;0;encore-scheduler;%s", it.Hostgroup, startTS, endTS, it.Comment))
		}
		it.LastRunDate = today
	}
	_ = rs.saveLocked()
	rs.mu.Unlock()

	f, err := os.OpenFile(rs.cmdPipePath, os.O_WRONLY, 0)
	if err != nil {
		return 0
	}
	defer f.Close()
	sent := 0
	for _, c := range cmds {
		if _, err := fmt.Fprintf(f, "[%d] %s\n", startTS, c); err == nil {
			sent++
		}
	}
	return sent
}

func (rs *RecurringStore) RunLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case t := <-ticker.C:
			rs.Tick(t)
		}
	}
}

func registerRecurringRoutes(mux *http.ServeMux, rs *RecurringStore) {
	mux.HandleFunc("/api/v1/downtimes/recurring", func(w http.ResponseWriter, r *http.Request) {
		actor := actorFromRequest(r)
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"schedules": rs.List()})
		case http.MethodPost, http.MethodPut:
			var item RecurringDowntime
			if err := decodeJSONBody(r, &item); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			saved, err := rs.Upsert(item, actor)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "schedule": saved})
		case http.MethodDelete:
			id := r.URL.Query().Get("id")
			if err := rs.Delete(id, actor); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})
}
