package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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
	handler := newHTTPHandler(store, "", "", "", "", "", "", "", "", cs)

	// Dashboard HTML + embedded assets + modular css/js
	for _, p := range []string{"/", "/favicon.ico", "/assets/logo/logo.svg", "/assets/status/status-ok.svg", "/assets/icons/dashboard.svg", "/css/app.css", "/js/core.js", "/js/monitor.js", "/js/manage.js", "/js/guide.js", "/js/reports.js"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
			t.Fatalf("expected 200 for %s, got %d (len=%d)", p, rec.Code, rec.Body.Len())
		}
	}

	// Summary with unhandled count
	req := httptest.NewRequest(http.MethodGet, "/api/v1/summary", nil)
	rec := httptest.NewRecorder()
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

func TestParseAndAdoptLocalhost(t *testing.T) {
	sample := `
define host {
    use         linux-server
    host_name   localhost
    alias       localhost
    address     127.0.0.1
}
define hostgroup {
    hostgroup_name  linux-servers
    alias           Linux Servers
    members         localhost
}
define service {
    use                 local-service
    host_name           localhost
    service_description PING
    check_command       check_ping!100.0,20%!500.0,60%
}
define service {
    use                 local-service
    host_name           localhost
    service_description Root Partition
    check_command       check_local_disk!20%!10%!/
}
`
	hosts, svcs, hgs := ParseNagiosObjectFile(sample)
	if len(hosts) != 1 || hosts[0].Name != "localhost" {
		t.Fatalf("unexpected parsed hosts: %+v", hosts)
	}
	if len(svcs) != 2 || len(hgs) != 1 {
		t.Fatalf("unexpected parsed svcs=%d hgs=%d", len(svcs), len(hgs))
	}
}

func TestCustomScriptsAPI(t *testing.T) {
	dir := t.TempDir()
	cs, err := NewConfigStore(dir, "", "", "")
	if err != nil {
		t.Fatalf("NewConfigStore: %v", err)
	}
	handler := newHTTPHandler(NewStateStore(), "", "", "", "", "", "", "", "", cs)

	// Create script
	body := `{"name":"check_hello.sh","content":"#!/bin/sh\necho \"OK - hello $1 | v=1\"\nexit 0\n"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/scripts", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("save script failed: %d %s", rec.Code, rec.Body.String())
	}

	// Test run script
	req = httptest.NewRequest(http.MethodPost, "/api/v1/scripts/test", bytes.NewBufferString(`{"name":"check_hello.sh","args":"world"}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("test script failed: %d %s", rec.Code, rec.Body.String())
	}
	var tr struct {
		ExitCode int    `json:"exit_code"`
		Stdout   string `json:"stdout"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &tr)
	if tr.ExitCode != 0 || !bytes.Contains([]byte(tr.Stdout), []byte("hello world")) {
		t.Fatalf("unexpected script test result: %+v", tr)
	}
}

func TestSecretsAPI(t *testing.T) {
	dir := t.TempDir()
	resPath := dir + "/resource.cfg"
	if err := os.WriteFile(resPath, []byte("$USER1$=/usr/lib/nagios/plugins\n"), 0o640); err != nil {
		t.Fatalf("write resource.cfg: %v", err)
	}
	cs, _ := NewConfigStore(dir, "", "", "")
	handler := newHTTPHandler(NewStateStore(), "", "", "", "", resPath, "", "", "", cs)

	// Protect $USER1$
	req := httptest.NewRequest(http.MethodPost, "/api/v1/secrets", bytes.NewBufferString(`{"key":"$USER1$","value":"hack"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when modifying $USER1$, got %d", rec.Code)
	}

	// Set $USER2$
	req = httptest.NewRequest(http.MethodPost, "/api/v1/secrets", bytes.NewBufferString(`{"key":"$USER2$","value":"supersecret9876"}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("set $USER2$ failed: %d %s", rec.Code, rec.Body.String())
	}

	// Verify masked GET
	req = httptest.NewRequest(http.MethodGet, "/api/v1/secrets", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if !bytes.Contains(rec.Body.Bytes(), []byte("••••••9876")) || bytes.Contains(rec.Body.Bytes(), []byte("supersecret9876")) {
		t.Fatalf("secret was not properly masked: %s", rec.Body.String())
	}
}

func TestReportsAndBasicAuth(t *testing.T) {
	dir := t.TempDir()
	logPath := dir + "/nagios.log"
	sampleLog := `[1700000100] SERVICE ALERT: web-01;HTTP;CRITICAL;HARD;3;Connection refused
[1700000400] SERVICE ALERT: web-01;HTTP;OK;HARD;1;HTTP OK
[1700000500] SERVICE NOTIFICATION: admin;web-01;HTTP;OK;notify-service-by-email;HTTP OK
`
	if err := os.WriteFile(logPath, []byte(sampleLog), 0o644); err != nil {
		t.Fatalf("write nagios.log: %v", err)
	}

	store := NewStateStore()
	store.ReplaceSnapshot(ProgramInfo{PID: 1},
		[]HostState{{Name: "web-01", CurrentState: 0, HasBeenChecked: 1}},
		[]ServiceState{{HostName: "web-01", Description: "HTTP", CurrentState: 0, HasBeenChecked: 1}},
	)
	cs, _ := NewConfigStore(dir, "", "", "")
	base := newHTTPHandler(store, "", "", "", "", "", "", logPath, "", cs)
	protected := basicAuthMiddleware("admin", "secret", base)

	// Unauthenticated request -> 401
	req := httptest.NewRequest(http.MethodGet, "/api/v1/reports/events?from=1700000000&to=1700001000", nil)
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Authenticated SLA availability check (300s CRIT out of 1000s = 70% OK, 1 incident, MTTR=300s)
	req = httptest.NewRequest(http.MethodGet, "/api/v1/reports/availability?from=1700000000&to=1700001000&target=services", nil)
	req.SetBasicAuth("admin", "secret")
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var avail struct {
		Summary AvailabilitySummary `json:"summary"`
		Rows    []AvailabilityRow   `json:"rows"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &avail)
	if len(avail.Rows) != 1 || avail.Rows[0].Incidents != 1 || avail.Rows[0].OKPct != 70.0 || avail.Rows[0].MTTRSec != 300.0 {
		t.Fatalf("unexpected availability result: %+v", avail)
	}

	// CSV export
	req = httptest.NewRequest(http.MethodGet, "/api/v1/reports/export?from=1700000000&to=1700001000&target=services&format=csv", nil)
	req.SetBasicAuth("admin", "secret")
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte("web-01,HTTP,70.00")) {
		t.Fatalf("unexpected CSV export: %d %s", rec.Code, rec.Body.String())
	}

	// Printable HTML export
	req = httptest.NewRequest(http.MethodGet, "/api/v1/reports/export?from=1700000000&to=1700001000&target=services&format=html", nil)
	req.SetBasicAuth("admin", "secret")
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte("Encore Availability")) {
		t.Fatalf("unexpected HTML export: %d", rec.Code)
	}

	// Safe public /healthz bypasses Basic Auth, returns 503 when disconnected, 200 when connected, and leaks no internal fields
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !bytes.Contains(rec.Body.Bytes(), []byte(`"degraded"`)) || bytes.Contains(rec.Body.Bytes(), []byte("hosts")) {
		t.Fatalf("expected 503 minimal degraded /healthz, got %d %s", rec.Code, rec.Body.String())
	}

	store.connected.Store(true)
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"ok"`)) || bytes.Contains(rec.Body.Bytes(), []byte("hosts")) {
		t.Fatalf("expected 200 minimal ok /healthz, got %d %s", rec.Code, rec.Body.String())
	}

	// /health remains protected by Basic Auth
	req = httptest.NewRequest(http.MethodGet, "/health", nil)
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected /health to require Basic Auth, got %d", rec.Code)
	}

	// Reports per-service filter & timeline buckets
	req = httptest.NewRequest(http.MethodGet, "/api/v1/reports/availability?from=1700000000&to=1700007200&target=services&host=web-01&service=HTTP", nil)
	req.SetBasicAuth("admin", "secret")
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for filtered availability, got %d", rec.Code)
	}
	var availTL struct {
		Rows     []AvailabilityRow `json:"rows"`
		Timeline []TimelineBucket  `json:"timeline"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &availTL)
	if len(availTL.Rows) != 1 || len(availTL.Timeline) == 0 {
		t.Fatalf("expected 1 row and non-empty timeline, got %+v", availTL)
	}
}

func TestTemplatesBulkAndNotifications(t *testing.T) {
	dir := t.TempDir()
	store := NewStateStore()
	store.ReplaceSnapshot(ProgramInfo{PID: 1},
		[]HostState{{Name: "app-01", CurrentState: 0, HasBeenChecked: 1}},
		[]ServiceState{
			{HostName: "app-01", Description: "HTTP", CurrentState: 0, HasBeenChecked: 1, StateType: 1},
			{HostName: "app-01", Description: "DISK", CurrentState: 2, HasBeenChecked: 1, StateType: 1},
		},
	)
	cs, err := NewConfigStore(dir, "", "", "")
	if err != nil {
		t.Fatalf("NewConfigStore: %v", err)
	}
	_ = cs.UpsertHost(ManagedHost{Name: "app-01", Address: "10.0.0.10", Enabled: true})
	_ = cs.UpsertHost(ManagedHost{Name: "app-02", Address: "10.0.0.11", Enabled: true})

	handler := newHTTPHandler(store, "", "", "", "", "", "", "", "", cs)

	// 1. problems=1 filter returns only non-OK service
	req := httptest.NewRequest(http.MethodGet, "/api/v1/services?problems=1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var pResp struct {
		Total    int            `json:"total"`
		Services []ServiceState `json:"services"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pResp)
	if pResp.Total != 1 || pResp.Services[0].Description != "DISK" {
		t.Fatalf("expected 1 problem service (DISK), got %+v", pResp)
	}

	// 2. Starter templates exist & ApplyTemplate works + skips duplicates
	req = httptest.NewRequest(http.MethodPost, "/api/v1/config/templates/apply", bytes.NewBufferString(`{"template":"linux-ncpa-basic","hosts":["app-01","app-02"],"overwrite":false}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"added":8`)) {
		t.Fatalf("apply starter template failed: %d %s", rec.Code, rec.Body.String())
	}
	// Second apply skips all 8
	req = httptest.NewRequest(http.MethodPost, "/api/v1/config/templates/apply", bytes.NewBufferString(`{"template":"linux-ncpa-basic","hosts":["app-01","app-02"],"overwrite":false}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"skipped":8`)) {
		t.Fatalf("expected 8 skipped on re-apply: %s", rec.Body.String())
	}

	// 3. Save template from host
	req = httptest.NewRequest(http.MethodPost, "/api/v1/config/templates/from-host", bytes.NewBufferString(`{"host_name":"app-01","name":"from-app-01"}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"services":4`)) {
		t.Fatalf("save template from host failed: %d %s", rec.Code, rec.Body.String())
	}

	// 4. Bulk hosts disable
	req = httptest.NewRequest(http.MethodPost, "/api/v1/config/hosts/bulk", bytes.NewBufferString(`{"action":"disable","hosts":["app-02"]}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"affected":1`)) {
		t.Fatalf("bulk disable failed: %d %s", rec.Code, rec.Body.String())
	}

	// 4b. Bulk services delete
	req = httptest.NewRequest(http.MethodPost, "/api/v1/config/services/bulk", bytes.NewBufferString(`{"action":"delete","services":[{"host_name":"app-01","service_description":"NCPA CPU"},{"host_name":"app-01","service_description":"NCPA RAM"}]}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"affected":2`)) {
		t.Fatalf("bulk services delete failed: %d %s", rec.Code, rec.Body.String())
	}

	// 4c. Config diff reports pending changes & discard reverts them while keeping templates
	req = httptest.NewRequest(http.MethodGet, "/api/v1/config/diff", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var diffResp ConfigDiff
	_ = json.Unmarshal(rec.Body.Bytes(), &diffResp)
	if !diffResp.Pending || diffResp.Total == 0 {
		t.Fatalf("expected non-empty pending diff, got %+v", diffResp)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/config/discard", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("discard failed: %d %s", rec.Code, rec.Body.String())
	}
	if cs.Diff().Total != 0 {
		t.Fatalf("expected 0 diff after discard, got %+v", cs.Diff())
	}
	// Verify templates were preserved across discard
	snapCfg, _, _ := cs.Snapshot()
	if len(snapCfg.Templates) < 4 {
		t.Fatalf("expected templates preserved after discard, got %d", len(snapCfg.Templates))
	}

	// 5. Notification config masking + Webhook test delivery
	webhookHit := make(chan string, 2)
	whSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body bytes.Buffer
		_, _ = body.ReadFrom(r.Body)
		webhookHit <- body.String()
		w.WriteHeader(http.StatusOK)
	}))
	defer whSrv.Close()

	ncfg := `{"enabled":false,"smtp_host":"smtp.example.com","smtp_port":587,"smtp_tls":"starttls","smtp_user":"u","smtp_pass":"topsecret","from_address":"a@b.com","recipients":["ops@b.com"],"webhook_enabled":true,"webhook_type":"slack","webhook_url":"` + whSrv.URL + `","notify_critical":true,"hard_only":true}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/notifications/config", bytes.NewBufferString(ncfg))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || bytes.Contains(rec.Body.Bytes(), []byte("topsecret")) {
		t.Fatalf("notify config save/masking failed: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/notifications/test", bytes.NewBufferString(`{"channel":"webhook"}`))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("webhook test failed: %d %s", rec.Code, rec.Body.String())
	}
	got := <-webhookHit
	if !bytes.Contains([]byte(got), []byte("TEST")) || !bytes.Contains([]byte(got), []byte("Notification Test")) {
		t.Fatalf("unexpected webhook payload: %s", got)
	}

	// 6. Real-time SOFT -> HARD state transition dispatches webhook EXACTLY when becoming HARD (and no false recovery from SOFT)
	// First: OK(HARD) -> CRIT(SOFT 1/3) -> OK(HARD) must NOT dispatch alert or recovery
	store.ApplyServiceEvent(ServiceState{
		HostName: "app-01", Description: "HTTP", CurrentState: 2, HasBeenChecked: 1, StateType: 0, PluginOutput: "Transient blip",
	})
	store.ApplyServiceEvent(ServiceState{
		HostName: "app-01", Description: "HTTP", CurrentState: 0, HasBeenChecked: 1, StateType: 1, PluginOutput: "HTTP OK",
	})
	// Next: OK(HARD) -> CRIT(SOFT 1/3) -> CRIT(SOFT 2/3) -> CRIT(HARD 3/3) MUST dispatch HARD alert
	store.ApplyServiceEvent(ServiceState{
		HostName: "app-01", Description: "HTTP", CurrentState: 2, HasBeenChecked: 1, StateType: 0, PluginOutput: "502 SOFT 1",
	})
	store.ApplyServiceEvent(ServiceState{
		HostName: "app-01", Description: "HTTP", CurrentState: 2, HasBeenChecked: 1, StateType: 0, PluginOutput: "502 SOFT 2",
	})
	store.ApplyServiceEvent(ServiceState{
		HostName: "app-01", Description: "HTTP", CurrentState: 2, HasBeenChecked: 1, StateType: 1, PluginOutput: "502 Bad Gateway HARD",
	})
	gotAlert := <-webhookHit
	if !bytes.Contains([]byte(gotAlert), []byte("502 Bad Gateway HARD")) {
		t.Fatalf("expected SOFT->HARD transition alert in webhook, got: %s", gotAlert)
	}
	// Verify /api/v1/hosts/health aggregate endpoint
	req = httptest.NewRequest(http.MethodGet, "/api/v1/hosts/health", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"svc_crit":2`)) {
		t.Fatalf("unexpected /api/v1/hosts/health response: %d %s", rec.Code, rec.Body.String())
	}
}

func TestV7AuthRBACMetricsLegacyImportAndRecurring(t *testing.T) {
	dir := t.TempDir()
	cs, err := NewConfigStore(dir, "", "", "")
	if err != nil {
		t.Fatalf("NewConfigStore: %v", err)
	}
	store := NewStateStore()
	ms := NewMetricsStore(dir)
	store.SetMetrics(ms)
	am := NewAuthManager(dir, "admin", "AdminPass123", cs)

	mux := http.NewServeMux()
	registerAuthRoutes(mux, am)
	mux.Handle("/", newHTTPHandler(store, "", "", "", "", "", "", "", "", cs))
	srv := am.Middleware(mux)

	// 1. Login page & /healthz are public; /api/v1/summary requires auth
	req := httptest.NewRequest(http.MethodGet, "/login", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte("Operator Sign In")) {
		t.Fatalf("expected 200 for /login, got %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/summary", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 unauthenticated, got %d", rec.Code)
	}

	// 2. Session login as admin & create viewer + operator users
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"username":"admin","password":"AdminPass123"}`))
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || len(rec.Result().Cookies()) == 0 {
		t.Fatalf("admin login failed: %d %s", rec.Code, rec.Body.String())
	}
	adminCookie := rec.Result().Cookies()[0]

	req = httptest.NewRequest(http.MethodPost, "/api/v1/users", bytes.NewBufferString(`{"username":"nocview","display_name":"Viewer","role":"viewer","password":"ViewPass1","enabled":true}`))
	req.AddCookie(adminCookie)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create viewer failed: %d %s", rec.Code, rec.Body.String())
	}

	// 3. RBAC enforcement: viewer can GET /api/v1/summary (200) but gets 403 on /api/v1/users and /api/v1/command
	req = httptest.NewRequest(http.MethodGet, "/api/v1/summary", nil)
	req.SetBasicAuth("nocview", "ViewPass1")
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer summary expected 200, got %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/v1/command", bytes.NewBufferString(`{"command":"TEST"}`))
	req.SetBasicAuth("nocview", "ViewPass1")
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer command expected 403, got %d", rec.Code)
	}

	// 4. Time-series metrics parser & query
	store.ApplyServiceEvent(ServiceState{
		HostName: "web-01", Description: "NCPA CPU", CurrentState: 0, HasBeenChecked: 1,
		LastCheck: 1795500000, PerfData: "'percent'=42.5%;80;90;0;100 'user'=30.1%;;;;",
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/metrics?host=web-01&service=NCPA+CPU&range=7d", nil)
	req.AddCookie(adminCookie)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"label":"percent"`)) || !bytes.Contains(rec.Body.Bytes(), []byte(`"last":42.5`)) {
		t.Fatalf("metrics query failed: %d %s", rec.Code, rec.Body.String())
	}

	// 5. Legacy Nagios .cfg import (comma-separated hosts + register 0 skipped)
	legacyCfg := `
define host {
  name generic-host
  register 0
}
define host {
  host_name old-web-1
  address 10.1.1.10
  hostgroups legacy-web
}
define host {
  host_name old-web-2
  address 10.1.1.11
  hostgroups legacy-web
}
define service {
  host_name old-web-1,old-web-2
  service_description HTTP Legacy
  check_command check_http
}
`
	bodyBytes, _ := json.Marshal(map[string]any{"content": legacyCfg, "dry_run": false, "overwrite": false})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/config/import/nagios", bytes.NewReader(bodyBytes))
	req.AddCookie(adminCookie)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"hosts_new":2`)) || !bytes.Contains(rec.Body.Bytes(), []byte(`"services_new":2`)) {
		t.Fatalf("legacy import failed: %d %s", rec.Code, rec.Body.String())
	}

	// 6. Recurring downtime CRUD
	req = httptest.NewRequest(http.MethodPost, "/api/v1/downtimes/recurring", bytes.NewBufferString(`{"name":"Sunday Maint","target_type":"host","host":"old-web-1","days":[0],"start_time":"02:00","duration_min":120,"enabled":true}`))
	req.AddCookie(adminCookie)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte("Sunday Maint")) {
		t.Fatalf("recurring downtime create failed: %d %s", rec.Code, rec.Body.String())
	}

	// 7. Encore v8: Scheduled Digest config + Guardrailed Discovery validation + SSE EventBroker publish
	req = httptest.NewRequest(http.MethodPost, "/api/v1/reports/digest", bytes.NewBufferString(`{"enabled":true,"frequency":"weekly","day_of_week":1,"send_time":"08:00","window_days":7,"send_email":true}`))
	req.AddCookie(adminCookie)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"window_days":7`)) {
		t.Fatalf("digest config save failed: %d %s", rec.Code, rec.Body.String())
	}

	// Discovery rejects oversized /16 subnet guardrail
	req = httptest.NewRequest(http.MethodPost, "/api/v1/discovery/scan", bytes.NewBufferString(`{"target":"10.0.0.0/16"}`))
	req.AddCookie(adminCookie)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on oversized /16 scan, got %d", rec.Code)
	}

	// SSE EventBroker fan-out delivers published event
	broker := NewEventBroker()
	sub := broker.Subscribe()
	broker.Publish(SSEEvent{Kind: "service", Host: "web-01", Service: "SSL", State: 1, StateType: 1})
	msg := <-sub
	if !bytes.Contains(msg, []byte(`"SSL"`)) {
		t.Fatalf("unexpected SSE event payload: %s", string(msg))
	}
	broker.Unsubscribe(sub)
}

func TestSLAAccuracyWebhookAndSecurityHardening(t *testing.T) {
	// 1. SLA Accuracy: service currently CRITICAL for the last 5 minutes of a 24h window
	// MUST report ~99.65% OK and 1 HARD incident (not 0% OK / 0 incidents!)
	dir := t.TempDir()
	logPath := dir + "/nagios.log"
	from := int64(1700000000)
	to := from + 86400
	critAt := to - 300 // 5 min before end of window
	sampleLog := "[1700086100] SERVICE ALERT: web-01;HTTP;CRITICAL;HARD;3;Connection refused\n"
	if err := os.WriteFile(logPath, []byte(sampleLog), 0o644); err != nil {
		t.Fatalf("write log: %v", err)
	}
	store := NewStateStore()
	store.ReplaceSnapshot(
		ProgramInfo{PID: 1},
		[]HostState{{Name: "web-01", CurrentState: 0, HasBeenChecked: 1}},
		[]ServiceState{{HostName: "web-01", Description: "HTTP", CurrentState: 2, StateType: 1, HasBeenChecked: 1, LastStateChange: critAt}},
	)
	sum, rows, _ := computeAvailability(store, logPath, "", from, to, "services", "", "", "")
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	if rows[0].Incidents != 1 || rows[0].OKPct < 99.6 || rows[0].OKPct > 99.7 || rows[0].ProblemSec != 300 {
		t.Fatalf("inaccurate SLA calculation: got row=%+v sum=%+v", rows[0], sum)
	}

	// 2. Telegram/Webhook Emoji Formatting & WebhookURL Masking
	evCrit := AlertEvent{Kind: "service", Host: "db-01", Service: "MySQL", State: "CRITICAL", PrevState: "OK", Output: "Conn refused"}
	evOk := AlertEvent{Kind: "service", Host: "db-01", Service: "MySQL", State: "OK", PrevState: "CRITICAL", Output: "OK"}
	if tg := formatWebhookText(evCrit, "https://encore.local", true); !bytes.Contains([]byte(tg), []byte("🚨")) || !bytes.Contains([]byte(tg), []byte("<b>CRITICAL</b>")) {
		t.Fatalf("unexpected Telegram CRITICAL format: %s", tg)
	}
	if tg := formatWebhookText(evOk, "", true); !bytes.Contains([]byte(tg), []byte("✅")) || !bytes.Contains([]byte(tg), []byte("<b>RESOLVED</b>")) {
		t.Fatalf("unexpected Telegram RESOLVED format: %s", tg)
	}
	cs, _ := NewConfigStore(dir, "", "", "")
	ntf := NewNotifier(dir, cs)
	secretURL := "https://api.telegram.org/bot123456:SECRET_TOKEN_XYZ/sendMessage"
	if err := ntf.UpdateConfig(NotifyConfig{WebhookEnabled: true, WebhookType: "telegram", WebhookURL: secretURL}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	masked := ntf.ConfigMasked()
	if bytes.Contains([]byte(masked.WebhookURL), []byte("SECRET_TOKEN_XYZ")) {
		t.Fatalf("WebhookURL token leaked in ConfigMasked: %s", masked.WebhookURL)
	}
	// Saving masked value back must preserve original secret URL
	if err := ntf.UpdateConfig(masked); err != nil {
		t.Fatalf("UpdateConfig masked: %v", err)
	}
	if ntf.cfg.WebhookURL != secretURL {
		t.Fatalf("masked WebhookURL overwrote original secret")
	}

	// 3. Security Hardening: Operator command allowlist + X-Forwarded-For spoofing defense
	if !isOperatorAllowedCommand("SCHEDULE_FORCED_SVC_CHECK;web-01;HTTP;1700000000") {
		t.Fatalf("expected SCHEDULE_FORCED_SVC_CHECK to be allowed for operator")
	}
	if isOperatorAllowedCommand("SHUTDOWN_PROGRAM") || isOperatorAllowedCommand("RESTART_PROGRAM") || isOperatorAllowedCommand("DISABLE_NOTIFICATIONS") {
		t.Fatalf("admin-only engine commands must be blocked for operator")
	}
	spoofReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	spoofReq.RemoteAddr = "203.0.113.55:44321"
	spoofReq.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := clientIP(spoofReq); got != "203.0.113.55" {
		t.Fatalf("expected clientIP to ignore spoofed XFF from non-loopback, got %q", got)
	}
	proxyReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	proxyReq.RemoteAddr = "127.0.0.1:51234"
	proxyReq.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := clientIP(proxyReq); got != "198.51.100.7" {
		t.Fatalf("expected clientIP to trust XFF from loopback proxy, got %q", got)
	}
}

func TestInventoryByHostAPI(t *testing.T) {
	store := NewStateStore()
	store.ReplaceSnapshot(
		ProgramInfo{PID: 100},
		[]HostState{
			{Name: "app-01", Address: "10.0.1.1", CurrentState: 0, HasBeenChecked: 1},
			{Name: "db-01", Address: "10.0.1.2", CurrentState: 0, HasBeenChecked: 1},
		},
		[]ServiceState{
			{HostName: "app-01", Description: "CPU", CurrentState: 0, HasBeenChecked: 1},
			{HostName: "app-01", Description: "HTTP", CurrentState: 0, HasBeenChecked: 1},
			{HostName: "db-01", Description: "Disk", CurrentState: 2, HasBeenChecked: 1, PluginOutput: "98% full"},
			{HostName: "db-01", Description: "CPU", CurrentState: 0, HasBeenChecked: 1},
		},
	)
	store.ReplaceGroups(
		[]HostgroupInfo{{GroupName: "databases", Members: []string{"db-01"}}},
		nil,
	)
	cs, _ := NewConfigStore(t.TempDir(), "", "", "")
	handler := newHTTPHandler(store, "", "", "", "", "", "", "", "", cs)

	// Default sort puts host with problems (db-01) first, with all its services grouped & CRIT first
	req := httptest.NewRequest(http.MethodGet, "/api/v1/inventory/by-host", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Total int                  `json:"total"`
		Hosts []HostInventoryGroup `json:"hosts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Total != 2 || len(resp.Hosts) != 2 {
		t.Fatalf("expected 2 host groups, got %+v", resp)
	}
	if resp.Hosts[0].Host.Name != "db-01" || !resp.Hosts[0].HasProblem || resp.Hosts[0].SvcCrit != 1 || len(resp.Hosts[0].Services) != 2 {
		t.Fatalf("expected db-01 first with 1 CRIT and 2 services, got %+v", resp.Hosts[0])
	}
	if resp.Hosts[0].Services[0].Description != "Disk" {
		t.Fatalf("expected CRIT service Disk first inside db-01, got %s", resp.Hosts[0].Services[0].Description)
	}

	// Filter state=problems returns only db-01
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory/by-host?state=problems", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	resp = struct {
		Total int                  `json:"total"`
		Hosts []HostInventoryGroup `json:"hosts"`
	}{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Total != 1 || resp.Hosts[0].Host.Name != "db-01" {
		t.Fatalf("expected only db-01 for state=problems, got %+v", resp)
	}

	// Search by service name ("Disk") returns db-01 with only matching service
	req = httptest.NewRequest(http.MethodGet, "/api/v1/inventory/by-host?search=Disk", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	resp = struct {
		Total int                  `json:"total"`
		Hosts []HostInventoryGroup `json:"hosts"`
	}{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Total != 1 || len(resp.Hosts[0].Services) != 1 || resp.Hosts[0].Services[0].Description != "Disk" {
		t.Fatalf("expected search=Disk to return db-01 with Disk service, got %+v", resp)
	}
}
