package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
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

//go:embed web/index.html web/login.html web/assets web/css web/js
var webFS embed.FS

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
	Total         int `json:"total"`
	Up            int `json:"up"`
	Down          int `json:"down"`
	Unreachable   int `json:"unreachable"`
	Pending       int `json:"pending"`
	Unhandled     int `json:"unhandled"`
	UnhandledDown int `json:"unhandled_down"`
}

type ServiceCounts struct {
	Total             int `json:"total"`
	OK                int `json:"ok"`
	Warning           int `json:"warning"`
	Critical          int `json:"critical"`
	Unknown           int `json:"unknown"`
	Pending           int `json:"pending"`
	Unhandled         int `json:"unhandled"`
	UnhandledCritical int `json:"unhandled_critical"`
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
	notifier      *Notifier
	metrics       *MetricsStore
	broker        *EventBroker
}

func (s *StateStore) SetBroker(b *EventBroker) {
	s.mu.Lock()
	s.broker = b
	s.mu.Unlock()
}

func (s *StateStore) SetNotifier(n *Notifier) {
	s.mu.Lock()
	s.notifier = n
	s.mu.Unlock()
	if n != nil {
		n.SetStore(s)
	}
}

func (s *StateStore) SetMetrics(ms *MetricsStore) {
	s.mu.Lock()
	s.metrics = ms
	s.mu.Unlock()
}

func (s *StateStore) HostGroupsOf(host string) map[string]bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]bool)
	for g := range s.hostToGroups[host] {
		out[g] = true
	}
	return out
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
	ms := s.metrics
	s.mu.Unlock()
	if ms != nil {
		for _, sv := range services {
			if sv.HasBeenChecked == 1 && sv.PerfData != "" {
				ms.Record(sv.HostName, sv.Description, sv.PerfData, sv.LastCheck)
			}
		}
	}
}

func (s *StateStore) ApplyHostEvent(h HostState) {
	s.mu.Lock()
	prev := s.hosts[h.Name]
	hc := h
	s.hosts[hc.Name] = &hc
	notifier := s.notifier
	ms := s.metrics
	broker := s.broker
	s.mu.Unlock()
	s.eventsApplied.Add(1)
	if ms != nil && hc.HasBeenChecked == 1 && hc.PerfData != "" {
		ms.Record(hc.Name, "_HOST_", hc.PerfData, hc.LastCheck)
	}
	if broker != nil {
		prevSt := hc.CurrentState
		if prev != nil {
			prevSt = prev.CurrentState
		}
		broker.Publish(SSEEvent{
			Kind: "host", Host: hc.Name, State: hc.CurrentState, PrevState: prevSt,
			StateType: hc.StateType, Output: hc.PluginOutput, TS: time.Now().Unix(),
		})
	}
	if notifier != nil && prev != nil {
		notifier.OnHostTransition(prev, hc)
	}
}

func (s *StateStore) ApplyServiceEvent(sv ServiceState) {
	s.mu.Lock()
	k := svcKey(sv.HostName, sv.Description)
	prev := s.services[k]
	sc := sv
	s.services[k] = &sc
	notifier := s.notifier
	ms := s.metrics
	broker := s.broker
	s.mu.Unlock()
	s.eventsApplied.Add(1)
	if ms != nil && sc.HasBeenChecked == 1 && sc.PerfData != "" {
		ms.Record(sc.HostName, sc.Description, sc.PerfData, sc.LastCheck)
	}
	if broker != nil {
		prevSt := sc.CurrentState
		if prev != nil {
			prevSt = prev.CurrentState
		}
		broker.Publish(SSEEvent{
			Kind: "service", Host: sc.HostName, Service: sc.Description, State: sc.CurrentState, PrevState: prevSt,
			StateType: sc.StateType, Output: sc.PluginOutput, TS: time.Now().Unix(),
		})
	}
	if notifier != nil && prev != nil {
		notifier.OnServiceTransition(prev, sc)
	}
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
				if h.CurrentState == 1 {
					hc.UnhandledDown++
				}
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
				if sv.CurrentState == 2 {
					sc.UnhandledCritical++
				}
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
						if h.CurrentState == 1 {
							hc.UnhandledDown++
						}
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
					if sv.CurrentState == 2 {
						sc.UnhandledCritical++
					}
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
						if sv.CurrentState == 2 {
							sc.UnhandledCritical++
						}
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
	ProblemsOnly bool
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
		if opts.ProblemsOnly && !(h.HasBeenChecked == 1 && h.CurrentState > 0) {
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
		if opts.ProblemsOnly && !(sv.HasBeenChecked == 1 && sv.CurrentState > 0) {
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

type HostInventoryGroup struct {
	Host       HostState      `json:"host"`
	Hostgroups []string       `json:"hostgroups,omitempty"`
	SvcOK      int            `json:"svc_ok"`
	SvcWarn    int            `json:"svc_warn"`
	SvcCrit    int            `json:"svc_crit"`
	SvcUnk     int            `json:"svc_unk"`
	SvcPend    int            `json:"svc_pend"`
	SvcTotal   int            `json:"svc_total"`
	HasProblem bool           `json:"has_problem"`
	Services   []ServiceState `json:"services"`
}

func (s *StateStore) QueryInventoryByHost(opts QueryOpts, healthFilter string) ([]HostInventoryGroup, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	searchLower := strings.ToLower(opts.Search)
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

	// Group services by host_name
	svcsByHost := make(map[string][]ServiceState, len(s.hosts))
	for _, sv := range s.services {
		if opts.Servicegroup != "" && !s.svcToGroups[svcKey(sv.HostName, sv.Description)][opts.Servicegroup] {
			continue
		}
		svcsByHost[sv.HostName] = append(svcsByHost[sv.HostName], *sv)
	}

	matched := make([]HostInventoryGroup, 0, len(s.hosts))
	for _, h := range s.hosts {
		if opts.Hostgroup != "" && !s.hostToGroups[h.Name][opts.Hostgroup] {
			continue
		}
		allSvcs := svcsByHost[h.Name]
		if opts.Servicegroup != "" && len(allSvcs) == 0 {
			continue
		}

		// Collect hostgroups sorted
		var hgs []string
		for g := range s.hostToGroups[h.Name] {
			hgs = append(hgs, g)
		}
		sort.Strings(hgs)

		grp := HostInventoryGroup{
			Host:       *h,
			Hostgroups: hgs,
			SvcTotal:   len(allSvcs),
		}
		for _, sv := range allSvcs {
			if sv.HasBeenChecked == 0 {
				grp.SvcPend++
				continue
			}
			switch sv.CurrentState {
			case 0:
				grp.SvcOK++
			case 1:
				grp.SvcWarn++
			case 2:
				grp.SvcCrit++
			default:
				grp.SvcUnk++
			}
		}
		hostBad := h.HasBeenChecked == 1 && h.CurrentState > 0
		grp.HasProblem = hostBad || grp.SvcWarn > 0 || grp.SvcCrit > 0 || grp.SvcUnk > 0

		// Health filter (problems / healthy)
		if healthFilter == "problems" && !grp.HasProblem {
			continue
		}
		if healthFilter == "healthy" && grp.HasProblem {
			continue
		}

		// Filter services inside host based on search / state / unhandled
		hostSearchMatch := searchLower == "" ||
			strings.Contains(strings.ToLower(h.Name), searchLower) ||
			strings.Contains(strings.ToLower(h.Address), searchLower) ||
			strings.Contains(strings.ToLower(h.PluginOutput), searchLower)
		hostUnhandled := hostBad && h.Acknowledged == 0 && h.DowntimeDepth == 0

		filteredSvcs := make([]ServiceState, 0, len(allSvcs))
		for _, sv := range allSvcs {
			if opts.State != nil && sv.CurrentState != *opts.State {
				continue
			}
			if opts.Unhandled && !(sv.HasBeenChecked == 1 && sv.CurrentState > 0 && sv.Acknowledged == 0 && sv.DowntimeDepth == 0) {
				continue
			}
			if searchLower != "" && !hostSearchMatch {
				if !strings.Contains(strings.ToLower(sv.Description), searchLower) &&
					!strings.Contains(strings.ToLower(sv.PluginOutput), searchLower) {
					continue
				}
			}
			filteredSvcs = append(filteredSvcs, sv)
		}

		if searchLower != "" && !hostSearchMatch && len(filteredSvcs) == 0 {
			continue
		}
		if opts.Unhandled && !hostUnhandled && len(filteredSvcs) == 0 {
			continue
		}
		if opts.State != nil && len(filteredSvcs) == 0 {
			// Still keep host if filtering for CRITICAL(2) and host itself is DOWN, or OK(0) and host is UP with 0 services
			if !(*opts.State == 2 && h.CurrentState == 1) && !(*opts.State == 0 && h.CurrentState == 0 && len(allSvcs) == 0) {
				continue
			}
		}

		sort.Slice(filteredSvcs, func(i, j int) bool {
			si, sj := svcSeverity(filteredSvcs[i].CurrentState), svcSeverity(filteredSvcs[j].CurrentState)
			if si != sj {
				return si > sj
			}
			return filteredSvcs[i].Description < filteredSvcs[j].Description
		})
		grp.Services = filteredSvcs
		matched = append(matched, grp)
	}

	sort.Slice(matched, func(i, j int) bool {
		switch opts.SortBy {
		case "name":
			return matched[i].Host.Name < matched[j].Host.Name
		case "services":
			if matched[i].SvcTotal != matched[j].SvcTotal {
				return matched[i].SvcTotal > matched[j].SvcTotal
			}
		default: // severity / problems first
			if matched[i].HasProblem != matched[j].HasProblem {
				return matched[i].HasProblem
			}
			iHostDown := matched[i].Host.HasBeenChecked == 1 && matched[i].Host.CurrentState > 0
			jHostDown := matched[j].Host.HasBeenChecked == 1 && matched[j].Host.CurrentState > 0
			if iHostDown != jHostDown {
				return iHostDown
			}
			if matched[i].SvcCrit != matched[j].SvcCrit {
				return matched[i].SvcCrit > matched[j].SvcCrit
			}
			if matched[i].SvcWarn != matched[j].SvcWarn {
				return matched[i].SvcWarn > matched[j].SvcWarn
			}
		}
		return matched[i].Host.Name < matched[j].Host.Name
	})

	total := len(matched)
	if opts.Offset >= total {
		return []HostInventoryGroup{}, total
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
		ProblemsOnly: q.Get("problems") == "1" || q.Get("problems") == "true",
		Search:       q.Get("search"),
		SortBy:       q.Get("sort"),
		Offset:       offset,
		Limit:        limit,
	}, nil
}

var gzipWriterPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return w
	},
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
	shouldGzip  bool
}

func (g *gzipResponseWriter) initGzip() {
	if g.wroteHeader {
		return
	}
	ct := g.Header().Get("Content-Type")
	if strings.Contains(ct, "json") || strings.Contains(ct, "text/") || strings.Contains(ct, "javascript") || strings.Contains(ct, "svg") {
		g.shouldGzip = true
		g.Header().Set("Content-Encoding", "gzip")
		g.Header().Add("Vary", "Accept-Encoding")
		g.Header().Del("Content-Length")
		gw := gzipWriterPool.Get().(*gzip.Writer)
		gw.Reset(g.ResponseWriter)
		g.gz = gw
	}
}

func (g *gzipResponseWriter) WriteHeader(code int) {
	g.initGzip()
	g.wroteHeader = true
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if !g.wroteHeader {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.shouldGzip && g.gz != nil {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never buffer SSE streaming responses
		if r.URL.Path == "/api/v1/stream" || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipResponseWriter{ResponseWriter: w}
		defer func() {
			if gw.gz != nil {
				_ = gw.gz.Close()
				gzipWriterPool.Put(gw.gz)
			}
		}()
		next.ServeHTTP(gw, r)
	})
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if r.TLS != nil {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/") && r.URL.Path != "/api/v1/stream" {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

var operatorAllowedCommands = map[string]bool{
	"SCHEDULE_FORCED_HOST_CHECK":   true,
	"SCHEDULE_FORCED_SVC_CHECK":    true,
	"ACKNOWLEDGE_HOST_PROBLEM":     true,
	"ACKNOWLEDGE_SVC_PROBLEM":      true,
	"REMOVE_HOST_ACKNOWLEDGEMENT":  true,
	"REMOVE_SVC_ACKNOWLEDGEMENT":   true,
	"SCHEDULE_HOST_DOWNTIME":       true,
	"SCHEDULE_SVC_DOWNTIME":        true,
	"DEL_HOST_DOWNTIME":            true,
	"DEL_SVC_DOWNTIME":             true,
	"ADD_HOST_COMMENT":             true,
	"ADD_SVC_COMMENT":              true,
	"DEL_HOST_COMMENT":             true,
	"DEL_SVC_COMMENT":              true,
}

func isOperatorAllowedCommand(cmd string) bool {
	name := cmd
	if idx := strings.IndexByte(cmd, ';'); idx > 0 {
		name = cmd[:idx]
	}
	return operatorAllowedCommands[strings.ToUpper(strings.TrimSpace(name))]
}

func basicAuthMiddleware(user, pass string, next http.Handler) http.Handler {
	if user == "" || pass == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" || r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		u, p, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(u), []byte(user)) != 1 ||
			subtle.ConstantTimeCompare([]byte(p), []byte(pass)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Encore Monitor"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newHTTPHandler(store *StateStore, qhPath, cmdPipePath, localhostCfgPath, commandsCfgPath, resourceCfgPath, nagiosCfgPath, nagiosLogPath, archivesDir string, cs *ConfigStore) http.Handler {
	mux := http.NewServeMux()

	assetsSub, _ := fs.Sub(webFS, "web/assets")
	assetsHandler := http.StripPrefix("/assets/", http.FileServer(http.FS(assetsSub)))
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=86400")
		assetsHandler.ServeHTTP(w, r)
	})
	cssSub, _ := fs.Sub(webFS, "web/css")
	cssHandler := http.StripPrefix("/css/", http.FileServer(http.FS(cssSub)))
	mux.HandleFunc("/css/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		cssHandler.ServeHTTP(w, r)
	})
	jsSub, _ := fs.Sub(webFS, "web/js")
	jsHandler := http.StripPrefix("/js/", http.FileServer(http.FS(jsSub)))
	mux.HandleFunc("/js/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		jsHandler.ServeHTTP(w, r)
	})
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/assets/favicon/favicon.ico")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/x-icon")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(data)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		data, err := webFS.ReadFile("web/index.html")
		if err != nil {
			http.Error(w, "dashboard missing", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	})

	// Public, minimal, safe healthcheck endpoint (exempt from Basic Auth).
	// Exposes only liveness/readiness status with zero internal metadata.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		if store.connected.Load() {
			w.WriteHeader(http.StatusOK)
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(`{"status":"ok"}` + "\n"))
			}
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"status":"degraded"}` + "\n"))
		}
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		sum := store.Summary()
		store.mu.RLock()
		lastSync := store.lastSync
		store.mu.RUnlock()
		_, pending, cfgEnabled := cs.Snapshot()
		var pDiff map[string]int
		if pending {
			d := cs.Diff()
			pDiff = map[string]int{"added": d.Added, "modified": d.Modified, "deleted": d.Deleted, "total": d.Total}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "ok",
			"connected":       store.connected.Load(),
			"hosts":           sum.Hosts.Total,
			"services":        sum.Services.Total,
			"events_applied":  store.eventsApplied.Load(),
			"last_sync":       lastSync,
			"config_enabled":  cfgEnabled,
			"pending_changes": pending,
			"pending_diff":    pDiff,
		})
	})

	// Lightweight aggregate endpoint for Overview Fleet Health Map (scales to 1000+ services)
	mux.HandleFunc("/api/v1/hosts/health", func(w http.ResponseWriter, r *http.Request) {
		type hostHealthItem struct {
			Name           string `json:"name"`
			Address        string `json:"address"`
			CurrentState   int    `json:"current_state"`
			HasBeenChecked int    `json:"has_been_checked"`
			SvcOK          int    `json:"svc_ok"`
			SvcWarn        int    `json:"svc_warn"`
			SvcCrit        int    `json:"svc_crit"`
			SvcUnk         int    `json:"svc_unk"`
			SvcTotal       int    `json:"svc_total"`
		}
		store.mu.RLock()
		m := make(map[string]*hostHealthItem, len(store.hosts))
		list := make([]*hostHealthItem, 0, len(store.hosts))
		for _, h := range store.hosts {
			it := &hostHealthItem{
				Name:           h.Name,
				Address:        h.Address,
				CurrentState:   h.CurrentState,
				HasBeenChecked: h.HasBeenChecked,
			}
			m[h.Name] = it
			list = append(list, it)
		}
		for _, sv := range store.services {
			it, ok := m[sv.HostName]
			if !ok {
				continue
			}
			it.SvcTotal++
			if sv.HasBeenChecked == 0 {
				continue
			}
			switch sv.CurrentState {
			case 0:
				it.SvcOK++
			case 1:
				it.SvcWarn++
			case 2:
				it.SvcCrit++
			default:
				it.SvcUnk++
			}
		}
		store.mu.RUnlock()
		sort.Slice(list, func(i, j int) bool {
			// Unhealthy hosts first, then alphabetical
			iBad := list[i].CurrentState > 0 || list[i].SvcCrit > 0
			jBad := list[j].CurrentState > 0 || list[j].SvcCrit > 0
			if iBad != jBad {
				return iBad
			}
			return list[i].Name < list[j].Name
		})
		writeJSON(w, http.StatusOK, map[string]any{"hosts": list})
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

	mux.HandleFunc("/api/v1/inventory/by-host", func(w http.ResponseWriter, r *http.Request) {
		healthFilter := ""
		q := r.URL.Query()
		stRaw := q.Get("state")
		if stRaw == "problems" || stRaw == "healthy" {
			healthFilter = stRaw
			// Clone query without non-numeric state so parseQueryOpts succeeds cleanly
			qCopy := r.URL.Query()
			qCopy.Del("state")
			rClone := r.Clone(r.Context())
			rClone.URL.RawQuery = qCopy.Encode()
			r = rClone
		}
		opts, err := parseQueryOpts(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		groups, total := store.QueryInventoryByHost(opts, healthFilter)
		writeJSON(w, http.StatusOK, map[string]any{
			"total":  total,
			"offset": opts.Offset,
			"count":  len(groups),
			"hosts":  groups,
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
		if actorRoleFromRequest(r) != RoleAdmin && !isOperatorAllowedCommand(cmd) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: engine control command requires admin role"})
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

	mux.HandleFunc("/api/v1/commands/batch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		if cmdPipePath == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "command pipe not configured"})
			return
		}
		var req struct {
			Commands []string `json:"commands"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if len(req.Commands) == 0 || len(req.Commands) > 200 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "commands must contain 1..200 entries"})
			return
		}
		isAdm := actorRoleFromRequest(r) == RoleAdmin
		for _, raw := range req.Commands {
			c := strings.TrimSpace(raw)
			if c != "" && !isAdm && !isOperatorAllowedCommand(c) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: batch contains admin-only engine command"})
				return
			}
		}
		f, err := os.OpenFile(cmdPipePath, os.O_WRONLY, 0)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer f.Close()
		now := time.Now().Unix()
		queued := 0
		for _, raw := range req.Commands {
			cmd := strings.TrimSpace(raw)
			if cmd == "" || strings.ContainsAny(cmd, "\r\n\x00") {
				continue
			}
			if _, err := fmt.Fprintf(f, "[%d] %s\n", now, cmd); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			queued++
		}
		cs.RecordAudit("batch_commands", fmt.Sprintf("%d commands", queued), "")
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "count": queued})
	})

	registerConfigRoutes(mux, cs, localhostCfgPath)
	registerCatalogRoutes(mux, cs, commandsCfgPath, resourceCfgPath, localhostCfgPath, nagiosCfgPath)
	registerScriptRoutes(mux, cs)
	registerSecretRoutes(mux, cs, resourceCfgPath, cmdPipePath)
	registerReportRoutes(mux, store, nagiosLogPath, archivesDir)
	store.mu.RLock()
	notifier := store.notifier
	ms := store.metrics
	broker := store.broker
	store.mu.RUnlock()
	if notifier == nil {
		notifier = NewNotifier(cs.managedDir, cs)
		store.SetNotifier(notifier)
	}
	if ms == nil {
		ms = NewMetricsStore(cs.managedDir)
		store.SetMetrics(ms)
	}
	if broker == nil {
		broker = NewEventBroker()
		store.SetBroker(broker)
	}
	registerNotifyRoutes(mux, notifier)
	registerMetricsRoutes(mux, ms)
	registerSSERoutes(mux, broker)
	dm := NewDigestManager(cs.managedDir, nagiosLogPath, archivesDir, store, notifier, cs)
	registerDigestRoutes(mux, dm)
	registerDiscoveryRoutes(mux, cs)
	rs := NewRecurringStore(cs.managedDir, cmdPipePath, store, cs)
	registerRecurringRoutes(mux, rs)
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
	listenAddr := flag.String("listen", "127.0.0.1:8080", "HTTP/HTTPS listen address")
	qhPath := flag.String("qh", "/usr/local/nagios/var/rw/nagios.qh", "Path to Encore Engine Query Handler Unix socket")
	encoreQH := flag.String("encore-qh", "", "Alias for -qh")
	cmdPath := flag.String("cmd", "", "Optional path to Encore external command pipe")
	encoreCmd := flag.String("encore-cmd", "", "Alias for -cmd")
	managedDir := flag.String("managed-dir", "", "Optional managed Encore config directory (e.g. /usr/local/nagios/etc/encore.d)")
	nagiosBin := flag.String("nagios-bin", "/usr/local/nagios/bin/nagios", "Path to Encore Engine binary for pre-flight validation (-v)")
	encoreBin := flag.String("encore-bin", "", "Alias for -nagios-bin")
	nagiosCfg := flag.String("nagios-cfg", "/usr/local/nagios/etc/nagios.cfg", "Path to main Encore Engine config for validation")
	encoreCfg := flag.String("encore-cfg", "", "Alias for -nagios-cfg")
	localhostCfg := flag.String("localhost-cfg", "/usr/local/nagios/etc/objects/localhost.cfg", "Path to localhost.cfg for dashboard management/adoption")
	commandsCfg := flag.String("commands-cfg", "/usr/local/nagios/etc/objects/commands.cfg", "Path to built-in commands.cfg for live command catalog")
	resourceCfg := flag.String("resource-cfg", "/usr/local/nagios/etc/resource.cfg", "Path to resource.cfg for $USER1$ plugin directory discovery")
	nagiosLog := flag.String("nagios-log", "/usr/local/nagios/var/nagios.log", "Path to active Encore Engine log for historical reports")
	encoreLog := flag.String("encore-log", "", "Alias for -nagios-log")
	archivesDir := flag.String("archives-dir", "/usr/local/nagios/var/archives", "Path to archived Encore Engine log directory")
	authUser := flag.String("auth-user", "", "Optional seed admin username for RBAC login")
	authPass := flag.String("auth-pass", "", "Optional seed admin password for RBAC login")
	tlsCert := flag.String("tls-cert", "", "Optional TLS certificate PEM file for native HTTPS")
	tlsKey := flag.String("tls-key", "", "Optional TLS private key PEM file for native HTTPS")
	resyncInterval := flag.Duration("resync-interval", 5*time.Minute, "Periodic full snapshot resync interval (0 to disable)")
	flag.Parse()

	if *encoreQH != "" {
		*qhPath = *encoreQH
	}
	if *encoreCmd != "" {
		*cmdPath = *encoreCmd
	}
	if *encoreBin != "" {
		*nagiosBin = *encoreBin
	}
	if *encoreCfg != "" {
		*nagiosCfg = *encoreCfg
	}
	if *encoreLog != "" {
		*nagiosLog = *encoreLog
	}

	cfgStore, err := NewConfigStore(*managedDir, *nagiosBin, *nagiosCfg, *cmdPath)
	if err != nil {
		log.Fatalf("[gateway] config store init failed: %v", err)
	}

	store := NewStateStore()
	ms := NewMetricsStore(*managedDir)
	store.SetMetrics(ms)
	broker := NewEventBroker()
	store.SetBroker(broker)
	notifier := NewNotifier(*managedDir, cfgStore)
	store.SetNotifier(notifier)
	am := NewAuthManager(*managedDir, *authUser, *authPass, cfgStore)
	rs := NewRecurringStore(*managedDir, *cmdPath, store, cfgStore)
	dm := NewDigestManager(*managedDir, *nagiosLog, *archivesDir, store, notifier, cfgStore)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go runNERDLoop(ctx, *qhPath, store)
	go runPeriodicResync(ctx, *qhPath, store, *resyncInterval)
	go rs.RunLoop(ctx)
	go dm.RunLoop(ctx)
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = ms.SaveToDisk()
				return
			case <-t.C:
				_ = ms.SaveToDisk()
			}
		}
	}()

	mux := http.NewServeMux()
	registerAuthRoutes(mux, am)
	baseHandler := newHTTPHandler(store, *qhPath, *cmdPath, *localhostCfg, *commandsCfg, *resourceCfg, *nagiosCfg, *nagiosLog, *archivesDir, cfgStore)
	mux.Handle("/", baseHandler)

	srv := &http.Server{
		Addr:              *listenAddr,
		Handler:           securityHeadersMiddleware(gzipMiddleware(am.Middleware(mux))),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	if *tlsCert != "" && *tlsKey != "" {
		log.Printf("[gateway] listening on https://%s (qh=%s, managed-dir=%s)", *listenAddr, *qhPath, *managedDir)
		if err := srv.ListenAndServeTLS(*tlsCert, *tlsKey); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[gateway] TLS server error: %v", err)
		}
		return
	}
	log.Printf("[gateway] listening on http://%s (qh=%s, managed-dir=%s)", *listenAddr, *qhPath, *managedDir)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[gateway] server error: %v", err)
	}
}
