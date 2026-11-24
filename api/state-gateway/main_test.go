package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStateStoreAndHTTPAPI(t *testing.T) {
	store := NewStateStore()
	store.ReplaceSnapshot(
		ProgramInfo{PID: 1234, ProgramStart: 1700000000},
		[]HostState{
			{Name: "web-01", Address: "10.0.0.1", CurrentState: 0, HasBeenChecked: 1, PluginOutput: "OK"},
			{Name: "db-01", Address: "10.0.0.2", CurrentState: 1, HasBeenChecked: 1, PluginOutput: "DOWN"},
		},
		[]ServiceState{
			{HostName: "web-01", Description: "HTTP", CurrentState: 0, HasBeenChecked: 1, PluginOutput: "200 OK"},
			{HostName: "db-01", Description: "PG", CurrentState: 2, HasBeenChecked: 1, PluginOutput: "Connection refused"},
		},
	)

	// Apply live NERD delta event
	store.ApplyServiceEvent(ServiceState{
		HostName: "web-01", Description: "HTTP", CurrentState: 1, HasBeenChecked: 1, PluginOutput: "Slow response",
	})

	handler := newHTTPHandler(store, "")

	// Test summary
	req := httptest.NewRequest(http.MethodGet, "/api/v1/summary", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var sum SummaryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &sum); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if sum.Hosts.Total != 2 || sum.Hosts.Up != 1 || sum.Hosts.Down != 1 {
		t.Fatalf("unexpected host counts: %+v", sum.Hosts)
	}
	if sum.Services.Total != 2 || sum.Services.Warning != 1 || sum.Services.Critical != 1 {
		t.Fatalf("unexpected service counts: %+v", sum.Services)
	}

	// Test filtered services query
	req = httptest.NewRequest(http.MethodGet, "/api/v1/services?state=2&host=db-01", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var svcResp struct {
		Total    int            `json:"total"`
		Services []ServiceState `json:"services"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &svcResp); err != nil {
		t.Fatalf("decode services: %v", err)
	}
	if svcResp.Total != 1 || svcResp.Services[0].Description != "PG" {
		t.Fatalf("unexpected services response: %+v", svcResp)
	}
}
