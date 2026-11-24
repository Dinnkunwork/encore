package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type ProgramInfo struct {
	PID          int   `json:"pid"`
	ProgramStart int64 `json:"program_start"`
}

type HostState struct {
	Name            string  `json:"name"`
	Address         string  `json:"address"`
	CurrentState    int     `json:"current_state"`
	StateType       int     `json:"state_type"`
	HasBeenChecked  int     `json:"has_been_checked"`
	CurrentAttempt  int     `json:"current_attempt"`
	MaxAttempts     int     `json:"max_attempts"`
	LastCheck       int64   `json:"last_check"`
	NextCheck       int64   `json:"next_check"`
	LastStateChange int64   `json:"last_state_change"`
	Acknowledged    int     `json:"acknowledged"`
	DowntimeDepth   int     `json:"downtime_depth"`
	IsFlapping      int     `json:"is_flapping"`
	Latency         float64 `json:"latency"`
	ExecutionTime   float64 `json:"execution_time"`
	PluginOutput    string  `json:"plugin_output"`
	PerfData        string  `json:"perf_data"`
}

type ServiceState struct {
	HostName        string  `json:"host_name"`
	Description     string  `json:"description"`
	CurrentState    int     `json:"current_state"`
	StateType       int     `json:"state_type"`
	HasBeenChecked  int     `json:"has_been_checked"`
	CurrentAttempt  int     `json:"current_attempt"`
	MaxAttempts     int     `json:"max_attempts"`
	LastCheck       int64   `json:"last_check"`
	NextCheck       int64   `json:"next_check"`
	LastStateChange int64   `json:"last_state_change"`
	Acknowledged    int     `json:"acknowledged"`
	DowntimeDepth   int     `json:"downtime_depth"`
	IsFlapping      int     `json:"is_flapping"`
	Latency         float64 `json:"latency"`
	ExecutionTime   float64 `json:"execution_time"`
	PluginOutput    string  `json:"plugin_output"`
	PerfData        string  `json:"perf_data"`
}

type HostCounts struct {
	Total       int `json:"total"`
	Up          int `json:"up"`
	Down        int `json:"down"`
	Unreachable int `json:"unreachable"`
	Pending     int `json:"pending"`
}

type ServiceCounts struct {
	Total    int `json:"total"`
	OK       int `json:"ok"`
	Warning  int `json:"warning"`
	Critical int `json:"critical"`
	Unknown  int `json:"unknown"`
	Pending  int `json:"pending"`
}

type SummaryResponse struct {
	Program  ProgramInfo   `json:"program"`
	Hosts    HostCounts    `json:"hosts"`
	Services ServiceCounts `json:"services"`
}

type StateEvent struct {
	Type string `json:"type"`
	HostState
	ServiceState
}

type StateStore struct {
	mu            sync.RWMutex
	program       ProgramInfo
	hosts         map[string]*HostState
	services      map[string]*ServiceState
	lastSync      time.Time
	eventsApplied atomic.Int64
	connected     atomic.Bool
}

func NewStateStore() *StateStore {
	return &StateStore{
		hosts:    make(map[string]*HostState),
		services: make(map[string]*ServiceState),
	}
}

func svcKey(hostName, desc string) string {
	return hostName + "\x00" + desc
}

func (s *StateStore) ReplaceSnapshot(prog ProgramInfo, hosts []HostState, services []ServiceState) {
	hm := make(map[string]*HostState, len(hosts))
	for i := range hosts {
		h := hosts[i]
		hm[h.Name] = &h
	}
	sm := make(map[string]*ServiceState, len(services))
	for i := range services {
		sv := services[i]
		sm[svcKey(sv.HostName, sv.Description)] = &sv
	}

	s.mu.Lock()
	s.program = prog
	s.hosts = hm
	s.services = sm
	s.lastSync = time.Now().UTC()
	s.mu.Unlock()
}

func (s *StateStore) ApplyHostEvent(h HostState) {
	s.mu.Lock()
	hc := h
	s.hosts[hc.Name] = &hc
	s.mu.Unlock()
	s.eventsApplied.Add(1)
}

func (s *StateStore) ApplyServiceEvent(sv ServiceState) {
	s.mu.Lock()
	sc := sv
	s.services[svcKey(sc.HostName, sc.Description)] = &sc
	s.mu.Unlock()
	s.eventsApplied.Add(1)
}

func (s *StateStore) Summary() SummaryResponse {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var hc HostCounts
	for _, h := range s.hosts {
		hc.Total++
		if h.HasBeenChecked == 0 {
			hc.Pending++
		} else {
			switch h.CurrentState {
			case 0:
				hc.Up++
			case 1:
				hc.Down++
			default:
				hc.Unreachable++
			}
		}
	}

	var sc ServiceCounts
	for _, sv := range s.services {
		sc.Total++
		if sv.HasBeenChecked == 0 {
			sc.Pending++
		} else {
			switch sv.CurrentState {
			case 0:
				sc.OK++
			case 1:
				sc.Warning++
			case 2:
				sc.Critical++
			default:
				sc.Unknown++
			}
		}
	}

	return SummaryResponse{
		Program:  s.program,
		Hosts:    hc,
		Services: sc,
	}
}

func (s *StateStore) QueryHosts(stateFilter *int, search string, offset, limit int) ([]HostState, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	searchLower := strings.ToLower(search)
	matched := make([]HostState, 0, len(s.hosts))
	for _, h := range s.hosts {
		if stateFilter != nil && h.CurrentState != *stateFilter {
			continue
		}
		if searchLower != "" && !strings.Contains(strings.ToLower(h.Name), searchLower) &&
			!strings.Contains(strings.ToLower(h.PluginOutput), searchLower) {
			continue
		}
		matched = append(matched, *h)
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i].Name < matched[j].Name })
	total := len(matched)
	if offset >= total {
		return []HostState{}, total
	}
	end := total
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	return matched[offset:end], total
}

func (s *StateStore) QueryServices(hostFilter string, stateFilter *int, search string, offset, limit int) ([]ServiceState, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	searchLower := strings.ToLower(search)
	matched := make([]ServiceState, 0, len(s.services))
	for _, sv := range s.services {
		if hostFilter != "" && sv.HostName != hostFilter {
			continue
		}
		if stateFilter != nil && sv.CurrentState != *stateFilter {
			continue
		}
		if searchLower != "" &&
			!strings.Contains(strings.ToLower(sv.HostName), searchLower) &&
			!strings.Contains(strings.ToLower(sv.Description), searchLower) &&
			!strings.Contains(strings.ToLower(sv.PluginOutput), searchLower) {
			continue
		}
		matched = append(matched, *sv)
	}
	sort.Slice(matched, func(i, j int) bool {
		if matched[i].HostName != matched[j].HostName {
			return matched[i].HostName < matched[j].HostName
		}
		return matched[i].Description < matched[j].Description
	})
	total := len(matched)
	if offset >= total {
		return []ServiceState{}, total
	}
	end := total
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	return matched[offset:end], total
}

func queryQH(sockPath, query string, timeout time.Duration) ([]byte, error) {
	conn, err := net.DialTimeout("unix", sockPath, timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	if _, err := conn.Write(append([]byte(query), 0)); err != nil {
		return nil, err
	}

	raw, err := io.ReadAll(conn)
	if err != nil {
		return nil, err
	}
	return bytes.TrimRight(raw, "\x00\r\n"), nil
}

func syncFromQH(sockPath string, store *StateStore) error {
	sumRaw, err := queryQH(sockPath, "#state summary", 5*time.Second)
	if err != nil {
		return fmt.Errorf("qh summary: %w", err)
	}
	var sum SummaryResponse
	if err := json.Unmarshal(sumRaw, &sum); err != nil {
		return fmt.Errorf("decode summary: %w", err)
	}

	hostsRaw, err := queryQH(sockPath, "#state hosts", 10*time.Second)
	if err != nil {
		return fmt.Errorf("qh hosts: %w", err)
	}
	var hosts []HostState
	if err := json.Unmarshal(hostsRaw, &hosts); err != nil {
		return fmt.Errorf("decode hosts: %w", err)
	}

	svcsRaw, err := queryQH(sockPath, "#state services", 15*time.Second)
	if err != nil {
		return fmt.Errorf("qh services: %w", err)
	}
	var svcs []ServiceState
	if err := json.Unmarshal(svcsRaw, &svcs); err != nil {
		return fmt.Errorf("decode services: %w", err)
	}

	store.ReplaceSnapshot(sum.Program, hosts, svcs)
	return nil
}

func runNERDLoop(ctx context.Context, sockPath string, store *StateStore) {
	backoff := 500 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}
		if err := syncFromQH(sockPath, store); err != nil {
			store.connected.Store(false)
			log.Printf("[sync] failed: %v (retrying in %v)", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 3*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = 500 * time.Millisecond

		conn, err := net.DialTimeout("unix", sockPath, 5*time.Second)
		if err != nil {
			store.connected.Store(false)
			log.Printf("[nerd] dial failed: %v", err)
			continue
		}
		if _, err := conn.Write([]byte("@nerd subscribe stateevents\x00")); err != nil {
			conn.Close()
			store.connected.Store(false)
			log.Printf("[nerd] subscribe failed: %v", err)
			continue
		}

		store.connected.Store(true)
		log.Printf("[nerd] subscribed to stateevents (hosts=%d, services=%d)",
			len(store.hosts), len(store.services))

		go func(c net.Conn) {
			<-ctx.Done()
			_ = c.Close()
		}(conn)

		scanner := bufio.NewScanner(conn)
		scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 || line[0] != '{' {
				continue
			}
			var header struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(line, &header); err != nil {
				continue
			}
			switch header.Type {
			case "host":
				var h HostState
				if err := json.Unmarshal(line, &h); err == nil && h.Name != "" {
					store.ApplyHostEvent(h)
				}
			case "service":
				var sv ServiceState
				if err := json.Unmarshal(line, &sv); err == nil && sv.HostName != "" {
					store.ApplyServiceEvent(sv)
				}
			}
		}

		_ = conn.Close()
		store.connected.Store(false)
		if ctx.Err() != nil {
			return
		}
		log.Printf("[nerd] stream disconnected (%v), resyncing...", scanner.Err())
		time.Sleep(500 * time.Millisecond)
	}
}

func parseOptInt(q string) (*int, error) {
	if q == "" {
		return nil, nil
	}
	v, err := strconv.Atoi(q)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func newHTTPHandler(store *StateStore, cmdPipePath string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		sum := store.Summary()
		store.mu.RLock()
		lastSync := store.lastSync
		store.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"status":         "ok",
			"connected":      store.connected.Load(),
			"hosts":          sum.Hosts.Total,
			"services":       sum.Services.Total,
			"events_applied": store.eventsApplied.Load(),
			"last_sync":      lastSync,
		})
	})

	mux.HandleFunc("/api/v1/summary", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, store.Summary())
	})

	mux.HandleFunc("/api/v1/hosts", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		stateFilter, err := parseOptInt(q.Get("state"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid state parameter"})
			return
		}
		offset, _ := strconv.Atoi(q.Get("offset"))
		limit, _ := strconv.Atoi(q.Get("limit"))
		if offset < 0 {
			offset = 0
		}
		items, total := store.QueryHosts(stateFilter, q.Get("search"), offset, limit)
		writeJSON(w, http.StatusOK, map[string]any{
			"total":  total,
			"offset": offset,
			"count":  len(items),
			"hosts":  items,
		})
	})

	mux.HandleFunc("/api/v1/services", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		stateFilter, err := parseOptInt(q.Get("state"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid state parameter"})
			return
		}
		offset, _ := strconv.Atoi(q.Get("offset"))
		limit, _ := strconv.Atoi(q.Get("limit"))
		if offset < 0 {
			offset = 0
		}
		items, total := store.QueryServices(q.Get("host"), stateFilter, q.Get("search"), offset, limit)
		writeJSON(w, http.StatusOK, map[string]any{
			"total":    total,
			"offset":   offset,
			"count":    len(items),
			"services": items,
		})
	})

	mux.HandleFunc("/api/v1/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		if cmdPipePath == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "command pipe not configured"})
			return
		}
		var req struct {
			Command string `json:"command"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		cmd := strings.TrimSpace(req.Command)
		if cmd == "" || strings.ContainsAny(cmd, "\r\n\x00") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid command"})
			return
		}
		f, err := os.OpenFile(cmdPipePath, os.O_WRONLY, 0)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer f.Close()
		line := fmt.Sprintf("[%d] %s\n", time.Now().Unix(), cmd)
		if _, err := f.WriteString(line); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued", "command": cmd})
	})

	return mux
}

func main() {
	listenAddr := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	qhPath := flag.String("qh", "/usr/local/nagios/var/rw/nagios.qh", "Path to Nagios Query Handler Unix socket")
	cmdPath := flag.String("cmd", "", "Optional path to Nagios external command file (nagios.cmd)")
	flag.Parse()

	store := NewStateStore()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go runNERDLoop(ctx, *qhPath, store)

	srv := &http.Server{
		Addr:              *listenAddr,
		Handler:           newHTTPHandler(store, *cmdPath),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Printf("[gateway] listening on %s (qh=%s)", *listenAddr, *qhPath)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[gateway] server error: %v", err)
	}
}
