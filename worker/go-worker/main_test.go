package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckTCPInProcess(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()

	host, port, _ := net.SplitHostPort(ln.Addr().String())
	w := NewWorker("test", "", []string{"check_tcp"}, 16)

	res := w.ExecuteCommand(context.Background(), "/usr/lib/nagios/plugins/check_tcp -H "+host+" -p "+port+" -t 2")
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "TCP OK") {
		t.Fatalf("expected TCP OK, got code=%d out=%q", res.ExitCode, res.Stdout)
	}
	if w.fastPath.Load() != 1 || w.fallback.Load() != 0 {
		t.Fatalf("expected fastPath=1 fallback=0, got %d/%d", w.fastPath.Load(), w.fallback.Load())
	}
}

func TestCheckHTTPInProcess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello-encore"))
	}))
	defer srv.Close()

	addr := strings.TrimPrefix(srv.URL, "http://")
	host, port, _ := net.SplitHostPort(addr)
	w := NewWorker("test", "", []string{"check_http"}, 16)

	res := w.ExecuteCommand(context.Background(), "/usr/lib/nagios/plugins/check_http -H "+host+" -p "+port+" -u / -s hello-encore")
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "HTTP OK") {
		t.Fatalf("expected HTTP OK, got code=%d out=%q", res.ExitCode, res.Stdout)
	}

	resFail := w.ExecuteCommand(context.Background(), "/usr/lib/nagios/plugins/check_http -H "+host+" -p "+port+" -u / -s missing-token")
	if resFail.ExitCode != 2 || !strings.Contains(resFail.Stdout, "HTTP CRITICAL") {
		t.Fatalf("expected HTTP CRITICAL on missing string, got code=%d out=%q", resFail.ExitCode, resFail.Stdout)
	}
}

func TestKVEncodeDecodeRoundtrip(t *testing.T) {
	orig := []kvPair{
		{Key: "job_id", Val: "42"},
		{Key: "type", Val: "0"},
		{Key: "outstd", Val: "OK - all good"},
	}
	raw := encodeKVMessage(orig)
	trimmed := raw[:len(raw)-len(msgDelim)]
	got := parseKVMessage(trimmed)
	if len(got) != len(orig) {
		t.Fatalf("expected %d pairs, got %d", len(orig), len(got))
	}
	for i := range orig {
		if got[i] != orig[i] {
			t.Fatalf("pair %d mismatch: %+v != %+v", i, got[i], orig[i])
		}
	}
}
