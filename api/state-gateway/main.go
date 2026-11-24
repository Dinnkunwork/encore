package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
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

//go:embed web/index.html
var dashboardHTML []byte

type ProgramInfo struct {
	PID                  int   `json:"pid"`
	ProgramStart         int64 `json:"program_start"`
	NotificationsEnabled int   `json:"notifications_enabled"`
	ExecuteServiceChecks int   `json:"execute_service_checks"`
	ExecuteHostChecks    int   `json:"execute_host_checks"`
	FlapDetectionEnabled int   `json:"flap_detection_enabled"`
	EventHandlersEnabled int   `json:"event_handlers_enabled"`
}

type HostgroupInfo struct {
	GroupName string   `json:"group_name"`
	Alias     string   `json:"alias"`
	Members   []string `json:"members"`
}

type ServicegroupMember struct {
	HostName    string `json:"host_name"`
	Description string `json:"description"`
}

type ServicegroupInfo struct {
	GroupName string               `json:"group_name"`
	Alias     string               `json:"alias"`
	Members   []ServicegroupMember `json:"members"`
}

type DowntimeInfo struct {
	DowntimeID         uint64 `json:"downtime_id"`
	Type               int    `json:"type"`
	HostName           string `json:"host_name"`
	ServiceDescription string `json:"service_description"`
	EntryTime          int64  `json:"entry_time"`
	StartTime          int64  `json:"start_time"`
	EndTime            int64  `json:"end_time"`
	Fixed              int    `json:"fixed"`
	Duration           uint64 `json:"duration"`
	IsInEffect         int    `json:"is_in_effect"`
	Author             string `json:"author"`
	Comment            string `json:"comment"`
}

type CommentInfo struct {
	CommentID          uint64 `json:"comment_id"`
	CommentType        int    `json:"comment_type"`
	EntryType          int    `json:"entry_type"`
	HostName           string `json:"host_name"`
	ServiceDescription string `json:"service_description"`
	EntryTime          int64  `json:"entry_time"`
	Persistent         int    `json:"persistent"`
	Author             string `json:"author"`
	CommentData        string `json:"comment_data"`
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
	Unhandled   int `json:"unhandled"`
}

type ServiceCounts struct {
	Total     int `json:"total"`
	OK        int `json:"ok"`
	Warning   int `json:"warning"`
	Critical  int `json:"critical"`
	Unknown   int `json:"unknown"`
	Pending   int `json:"pending"`
	Unhandled int `json:"unhandled"`
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
	hostgroups    []HostgroupInfo
	servicegroups []ServicegroupInfo
	hostToGroups  map[string]map[string]bool
	svcToGroups   map[string]map[string]bool
	lastSync      time.Time
	eventsApplied atomic.Int64
	connected     atomic.Bool
}

func NewStateStore() *StateStore {
	return &StateStore{
		hosts:        make(map[string]*HostState),
		services:     make(map[string]*ServiceState),
		hostToGroups: make(map[string]map[string]bool),
		svcToGroups:  make(map[string]map[string]bool),
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

func (s *StateStore) ReplaceGroups(hgs []HostgroupInfo, sgs []ServicegroupInfo) {
	h2g := make(map[string]map[string]bool)
	for _, g := range hgs {
		for _, m := range g.Members {
			if h2g[m] == nil {
				h2g[m] = make(map[string]bool)
			}
			h2g[m][g.GroupName] = true
		}
	}
	s2g := make(map[string]map[string]bool)
	for _, g := range sgs {
		for _, m := range g.Members {
			k := svcKey(m.HostName, m.Description)
			if s2g[k] == nil {
				s2g[k] = make(map[string]bool)
			}
			s2g[k][g.GroupName] = true
		}
	}
	s.mu.Lock()
	s.hostgroups = hgs
	s.servicegroups = sgs
	s.hostToGroups = h2g
	s.svcToGroups = s2g
	s.mu.Unlock()
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
			if h.CurrentState > 0 && h.Acknowledged == 0 && h.DowntimeDepth == 0 {
				hc.Unhandled++
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
			if sv.CurrentState > 0 && sv.Acknowledged == 0 && sv.DowntimeDepth == 0 {
				sc.Unhandled++
			}
		}
	}

	return SummaryResponse{
		Program:  s.program,
		Hosts:    hc,
		Services: sc,
	}
}

type HostgroupSummary struct {
	GroupName string        `json:"group_name"`
	Alias     string        `json:"alias"`
	Hosts     HostCounts    `json:"hosts"`
	Services  ServiceCounts `json:"services"`
}

type ServicegroupSummary struct {
	GroupName string        `json:"group_name"`
	Alias     string        `json:"alias"`
	Services  ServiceCounts `json:"services"`
}

func (s *StateStore) HostgroupSummaries() []HostgroupSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]HostgroupSummary, 0, len(s.hostgroups))
	for _, g := range s.hostgroups {
		memberSet := make(map[string]bool, len(g.Members))
		var hc HostCounts
		for _, m := range g.Members {
			memberSet[m] = true
			if h, ok := s.hosts[m]; ok {
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
					if h.CurrentState > 0 && h.Acknowledged == 0 && h.DowntimeDepth == 0 {
						hc.Unhandled++
					}
				}
			}
		}
		var sc ServiceCounts
		for _, sv := range s.services {
			if !memberSet[sv.HostName] {
				continue
			}
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
				if sv.CurrentState > 0 && sv.Acknowledged == 0 && sv.DowntimeDepth == 0 {
					sc.Unhandled++
				}
			}
		}
		out = append(out, HostgroupSummary{
			GroupName: g.GroupName,
			Alias:     g.Alias,
			Hosts:     hc,
			Services:  sc,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GroupName < out[j].GroupName })
	return out
}

func (s *StateStore) ServicegroupSummaries() []ServicegroupSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]ServicegroupSummary, 0, len(s.servicegroups))
	for _, g := range s.servicegroups {
		var sc ServiceCounts
		for _, m := range g.Members {
			if sv, ok := s.services[svcKey(m.HostName, m.Description)]; ok {
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
					if sv.CurrentState > 0 && sv.Acknowledged == 0 && sv.DowntimeDepth == 0 {
						sc.Unhandled++
					}
				}
			}
		}
		out = append(out, ServicegroupSummary{
			GroupName: g.GroupName,
			Alias:     g.Alias,
			Services:  sc,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GroupName < out[j].GroupName })
	return out
}

type QueryOpts struct {
	Host         string
	Hostgroup    string
	Servicegroup string
	State        *int
	StateType    *int
	Ack          *int
	Downtime     *int
	Unhandled    bool
	Search       string
	SortBy       string
	Offset       int
	Limit        int
}

func (s *StateStore) QueryHosts(opts QueryOpts) ([]HostState, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	searchLower := strings.ToLower(opts.Search)
	matched := make([]HostState, 0, len(s.hosts))
	for _, h := range s.hosts {
		if opts.Hostgroup != "" && !s.hostToGroups[h.Name][opts.Hostgroup] {
			continue
		}
		if opts.State != nil && h.CurrentState != *opts.State {
			continue
		}
		if opts.StateType != nil && h.StateType != *opts.StateType {
			continue
		}
		if opts.Ack != nil && h.Acknowledged != *opts.Ack {
			continue
		}
		if opts.Downtime != nil {
			inDT := 0
			if h.DowntimeDepth > 0 {
				inDT = 1
			}
			if inDT != *opts.Downtime {
				continue
			}
		}
		if opts.Unhandled && !(h.HasBeenChecked == 1 && h.CurrentState > 0 && h.Acknowledged == 0 && h.DowntimeDepth == 0) {
			continue
		}
		if searchLower != "" &&
			!strings.Contains(strings.ToLower(h.Name), searchLower) &&
			!strings.Contains(strings.ToLower(h.Address), searchLower) &&
			!strings.Contains(strings.ToLower(h.PluginOutput), searchLower) {
			continue
		}
		matched = append(matched, *h)
	}
	sort.Slice(matched, func(i, j int) bool {
		switch opts.SortBy {
		case "severity":
			if matched[i].CurrentState != matched[j].CurrentState {
				return matched[i].CurrentState > matched[j].CurrentState
			}
		case "last_check":
			if matched[i].LastCheck != matched[j].LastCheck {
				return matched[i].LastCheck > matched[j].LastCheck
			}
		case "duration":
			if matched[i].LastStateChange != matched[j].LastStateChange {
				return matched[i].LastStateChange < matched[j].LastStateChange
			}
		}
		return matched[i].Name < matched[j].Name
	})
	total := len(matched)
	if opts.Offset >= total {
		return []HostState{}, total
	}
	end := total
	if opts.Limit > 0 && opts.Offset+opts.Limit < end {
		end = opts.Offset + opts.Limit
	}
	return matched[opts.Offset:end], total
}

func (s *StateStore) QueryServices(opts QueryOpts) ([]ServiceState, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	searchLower := strings.ToLower(opts.Search)
	matched := make([]ServiceState, 0, len(s.services))
	for _, sv := range s.services {
		if opts.Host != "" && sv.HostName != opts.Host {
			continue
		}
		if opts.Hostgroup != "" && !s.hostToGroups[sv.HostName][opts.Hostgroup] {
			continue
		}
		if opts.Servicegroup != "" && !s.svcToGroups[svcKey(sv.HostName, sv.Description)][opts.Servicegroup] {
			continue
		}
		if opts.State != nil && sv.CurrentState != *opts.State {
			continue
		}
		if opts.StateType != nil && sv.StateType != *opts.StateType {
			continue
		}
		if opts.Ack != nil && sv.Acknowledged != *opts.Ack {
			continue
		}
		if opts.Downtime != nil {
			inDT := 0
			if sv.DowntimeDepth > 0 {
				inDT = 1
			}
			if inDT != *opts.Downtime {
				continue
			}
		}
		if opts.Unhandled && !(sv.HasBeenChecked == 1 && sv.CurrentState > 0 && sv.Acknowledged == 0 && sv.DowntimeDepth == 0) {
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
	svcSeverity := func(st int) int {
		switch st {
		case 2:
			return 4 // CRITICAL
		case 1:
			return 3 // WARNING
		case 3:
			return 2 // UNKNOWN
		default:
			return 1 // OK
		}
	}
	sort.Slice(matched, func(i, j int) bool {
		switch opts.SortBy {
		case "severity":
			si, sj := svcSeverity(matched[i].CurrentState), svcSeverity(matched[j].CurrentState)
			if si != sj {
				return si > sj
			}
		case "last_check":
			if matched[i].LastCheck != matched[j].LastCheck {
				return matched[i].LastCheck > matched[j].LastCheck
			}
		case "duration":
			if matched[i].LastStateChange != matched[j].LastStateChange {
				return matched[i].LastStateChange < matched[j].LastStateChange
			}
		}
		if matched[i].HostName != matched[j].HostName {
			return matched[i].HostName < matched[j].HostName
		}
		return matched[i].Description < matched[j].Description
	})
	total := len(matched)
	if opts.Offset >= total {
		return []ServiceState{}, total
	}
	end := total
	if opts.Limit > 0 && opts.Offset+opts.Limit < end {
		end = opts.Offset + opts.Limit
	}
	return matched[opts.Offset:end], total
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

	// Fetch hostgroups & servicegroups (best-effort)
	var hgs []HostgroupInfo
	if hgRaw, err := queryQH(sockPath, "#state hostgroups", 5*time.Second); err == nil {
		_ = json.Unmarshal(hgRaw, &hgs)
	}
	var sgs []ServicegroupInfo
	if sgRaw, err := queryQH(sockPath, "#state servicegroups", 5*time.Second); err == nil {
		_ = json.Unmarshal(sgRaw, &sgs)
	}
	store.ReplaceGroups(hgs, sgs)
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

func parseQueryOpts(r *http.Request) (QueryOpts, error) {
	q := r.URL.Query()
	st, err := parseOptInt(q.Get("state"))
	if err != nil {
		return QueryOpts{}, fmt.Errorf("invalid state")
	}
	stType, err := parseOptInt(q.Get("state_type"))
	if err != nil {
		return QueryOpts{}, fmt.Errorf("invalid state_type")
	}
	ack, err := parseOptInt(q.Get("ack"))
	if err != nil {
		return QueryOpts{}, fmt.Errorf("invalid ack")
	}
	dt, err := parseOptInt(q.Get("downtime"))
	if err != nil {
		return QueryOpts{}, fmt.Errorf("invalid downtime")
	}
	offset, _ := strconv.Atoi(q.Get("offset"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	if offset < 0 {
		offset = 0
	}
	return QueryOpts{
		Host:         q.Get("host"),
		Hostgroup:    q.Get("hostgroup"),
		Servicegroup: q.Get("servicegroup"),
		State:        st,
		StateType:    stType,
		Ack:          ack,
		Downtime:     dt,
		Unhandled:    q.Get("unhandled") == "1" || q.Get("unhandled") == "true",
		Search:       q.Get("search"),
		SortBy:       q.Get("sort"),
		Offset:       offset,
		Limit:        limit,
	}, nil
}

func newHTTPHandler(store *StateStore, qhPath, cmdPipePath string, cs *ConfigStore) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(dashboardHTML)
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		sum := store.Summary()
		store.mu.RLock()
		lastSync := store.lastSync
		store.mu.RUnlock()
		_, pending, cfgEnabled := cs.Snapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "ok",
			"connected":       store.connected.Load(),
			"hosts":           sum.Hosts.Total,
			"services":        sum.Services.Total,
			"events_applied":  store.eventsApplied.Load(),
			"last_sync":       lastSync,
			"config_enabled":  cfgEnabled,
			"pending_changes": pending,
		})
	})

	mux.HandleFunc("/api/v1/summary", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, store.Summary())
	})

	mux.HandleFunc("/api/v1/hostgroups", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"hostgroups": store.HostgroupSummaries()})
	})

	mux.HandleFunc("/api/v1/servicegroups", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"servicegroups": store.ServicegroupSummaries()})
	})

	mux.HandleFunc("/api/v1/downtimes", func(w http.ResponseWriter, r *http.Request) {
		if qhPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"downtimes": []DowntimeInfo{}})
			return
		}
		raw, err := queryQH(qhPath, "#state downtimes", 5*time.Second)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		var dts []DowntimeInfo
		_ = json.Unmarshal(raw, &dts)
		if dts == nil {
			dts = []DowntimeInfo{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"downtimes": dts})
	})

	mux.HandleFunc("/api/v1/comments", func(w http.ResponseWriter, r *http.Request) {
		if qhPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"comments": []CommentInfo{}})
			return
		}
		raw, err := queryQH(qhPath, "#state comments", 5*time.Second)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		var cms []CommentInfo
		_ = json.Unmarshal(raw, &cms)
		if cms == nil {
			cms = []CommentInfo{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"comments": cms})
	})

	mux.HandleFunc("/api/v1/hosts", func(w http.ResponseWriter, r *http.Request) {
		opts, err := parseQueryOpts(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		items, total := store.QueryHosts(opts)
		writeJSON(w, http.StatusOK, map[string]any{
			"total":  total,
			"offset": opts.Offset,
			"count":  len(items),
			"hosts":  items,
		})
	})

	mux.HandleFunc("/api/v1/services", func(w http.ResponseWriter, r *http.Request) {
		opts, err := parseQueryOpts(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		items, total := store.QueryServices(opts)
		writeJSON(w, http.StatusOK, map[string]any{
			"total":    total,
			"offset":   opts.Offset,
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
		cs.RecordAudit("external_command", cmd, "")
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued", "command": cmd})
	})

	registerConfigRoutes(mux, cs)
	return mux
}

func runPeriodicResync(ctx context.Context, sockPath string, store *StateStore, interval time.Duration) {
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !store.connected.Load() {
				continue
			}
			if err := syncFromQH(sockPath, store); err != nil {
				log.Printf("[resync] periodic sync failed: %v", err)
			}
		}
	}
}

func main() {
	listenAddr := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	qhPath := flag.String("qh", "/usr/local/nagios/var/rw/nagios.qh", "Path to Nagios Query Handler Unix socket")
	cmdPath := flag.String("cmd", "", "Optional path to Nagios external command file (nagios.cmd)")
	managedDir := flag.String("managed-dir", "", "Optional managed Nagios config directory (e.g. /usr/local/nagios/etc/encore.d)")
	nagiosBin := flag.String("nagios-bin", "/usr/local/nagios/bin/nagios", "Path to nagios binary for pre-flight validation (-v)")
	nagiosCfg := flag.String("nagios-cfg", "/usr/local/nagios/etc/nagios.cfg", "Path to nagios.cfg for pre-flight validation")
	resyncInterval := flag.Duration("resync-interval", 5*time.Minute, "Periodic full snapshot resync interval (0 to disable)")
	flag.Parse()

	cfgStore, err := NewConfigStore(*managedDir, *nagiosBin, *nagiosCfg, *cmdPath)
	if err != nil {
		log.Fatalf("[gateway] config store init failed: %v", err)
	}

	store := NewStateStore()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go runNERDLoop(ctx, *qhPath, store)
	go runPeriodicResync(ctx, *qhPath, store, *resyncInterval)

	srv := &http.Server{
		Addr:              *listenAddr,
		Handler:           newHTTPHandler(store, *qhPath, *cmdPath, cfgStore),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Printf("[gateway] listening on %s (qh=%s, managed-dir=%s)", *listenAddr, *qhPath, *managedDir)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[gateway] server error: %v", err)
	}
}
