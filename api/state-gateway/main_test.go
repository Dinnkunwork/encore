package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStateStoreAndHTTPAPI(t *testing.T) {
	store := NewStateStore()
	store.ReplaceSnapshot(
		ProgramInfo{PID: 1234, ProgramStart: 1700000000, NotificationsEnabled: 1, ExecuteServiceChecks: 1},
		[]HostState{
			{Name: "web-01", Address: "10.0.0.1", CurrentState: 0, HasBeenChecked: 1, PluginOutput: "OK"},
			{Name: "db-01", Address: "10.0.0.2", CurrentState: 1, HasBeenChecked: 1, PluginOutput: "DOWN"},
		},
		[]ServiceState{
			{HostName: "web-01", Description: "HTTP", CurrentState: 0, HasBeenChecked: 1, PluginOutput: "200 OK"},
			{HostName: "db-01", Description: "PG", CurrentState: 2, HasBeenChecked: 1, PluginOutput: "Connection refused"},
		},
	)
	store.ReplaceGroups(
		[]HostgroupInfo{{GroupName: "prod-web", Alias: "Prod Web", Members: []string{"web-01"}}},
		[]ServicegroupInfo{{GroupName: "databases", Alias: "DBs", Members: []ServicegroupMember{{HostName: "db-01", Description: "PG"}}}},
	)

	store.ApplyServiceEvent(ServiceState{
		HostName: "web-01", Description: "HTTP", CurrentState: 1, HasBeenChecked: 1, PluginOutput: "Slow response",
	})

	cs, err := NewConfigStore(t.TempDir(), "", "", "")
	if err != nil {
		t.Fatalf("NewConfigStore: %v", err)
	}
	handler := newHTTPHandler(store, "", "", cs)

	// Dashboard HTML
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("expected 200 HTML dashboard, got %d", rec.Code)
	}

	// Summary with unhandled count
	req = httptest.NewRequest(http.MethodGet, "/api/v1/summary", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var sum SummaryResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &sum)
	if sum.Hosts.Unhandled != 1 || sum.Services.Unhandled != 2 {
		t.Fatalf("unexpected unhandled counts: hosts=%+v svcs=%+v", sum.Hosts, sum.Services)
	}

	// Hostgroup filter
	req = httptest.NewRequest(http.MethodGet, "/api/v1/services?hostgroup=prod-web", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var svcResp struct {
		Total    int            `json:"total"`
		Services []ServiceState `json:"services"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &svcResp)
	if svcResp.Total != 1 || svcResp.Services[0].HostName != "web-01" {
		t.Fatalf("unexpected hostgroup filter response: %+v", svcResp)
	}

	// Hostgroups summary
	req = httptest.NewRequest(http.MethodGet, "/api/v1/hostgroups", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte("prod-web")) {
		t.Fatalf("expected prod-web in hostgroups: %s", rec.Body.String())
	}
}

func TestConfigStoreCRUDAndClone(t *testing.T) {
	dir := t.TempDir()
	cs, err := NewConfigStore(dir, "", "", "")
	if err != nil {
		t.Fatalf("NewConfigStore: %v", err)
	}

	if err := cs.UpsertHost(ManagedHost{
		Name: "web-01", Address: "10.0.0.10", CheckCommand: "check-host-alive", Enabled: true,
		Hostgroups: []string{"web"},
	}); err != nil {
		t.Fatalf("UpsertHost: %v", err)
	}
	if err := cs.UpsertService(ManagedService{
		HostName: "web-01", ServiceDescription: "HTTP", CheckCommand: "check_http", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertService: %v", err)
	}
	if err := cs.UpsertService(ManagedService{
		HostName: "web-01", ServiceDescription: "SSH", CheckCommand: "check_ssh", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertService 2: %v", err)
	}

	// Clone host WITH services
	n, err := cs.CloneHost("web-01", "web-02", "Web 02", "10.0.0.11", true)
	if err != nil {
		t.Fatalf("CloneHost: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected 2 cloned services, got %d", n)
	}

	// Clone single service to same host
	if err := cs.CloneService("web-02", "HTTP", "web-02", "HTTPS"); err != nil {
		t.Fatalf("CloneService: %v", err)
	}

	cfg, pending, enabled := cs.Snapshot()
	if !enabled || !pending || len(cfg.Hosts) != 2 || len(cfg.Services) != 5 {
		t.Fatalf("unexpected snapshot: hosts=%d svcs=%d pending=%v", len(cfg.Hosts), len(cfg.Services), pending)
	}

	// Reject injection characters
	if err := cs.UpsertHost(ManagedHost{Name: "bad\nhost", Address: "1.2.3.4", Enabled: true}); err == nil {
		t.Fatalf("expected error on newline in host name")
	}

	// Render & dry-run validate
	if _, err := cs.ValidateAndApply(true); err != nil {
		t.Fatalf("ValidateAndApply: %v", err)
	}
	if len(cs.ListBackups()) != 1 {
		t.Fatalf("expected 1 backup after apply, got %d", len(cs.ListBackups()))
	}
}
