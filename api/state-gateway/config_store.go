package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type ManagedHost struct {
	Name             string   `json:"name"`
	Alias            string   `json:"alias"`
	Address          string   `json:"address"`
	CheckCommand     string   `json:"check_command"`
	CheckInterval    int      `json:"check_interval"`
	RetryInterval    int      `json:"retry_interval"`
	MaxCheckAttempts int      `json:"max_check_attempts"`
	CheckPeriod      string   `json:"check_period"`
	Contacts         string   `json:"contacts"`
	Hostgroups       []string `json:"hostgroups,omitempty"`
	Enabled          bool     `json:"enabled"`
}

type ManagedService struct {
	HostName           string   `json:"host_name"`
	ServiceDescription string   `json:"service_description"`
	CheckCommand       string   `json:"check_command"`
	CheckInterval      int      `json:"check_interval"`
	RetryInterval      int      `json:"retry_interval"`
	MaxCheckAttempts   int      `json:"max_check_attempts"`
	CheckPeriod        string   `json:"check_period"`
	Contacts           string   `json:"contacts"`
	Servicegroups      []string `json:"servicegroups,omitempty"`
	Enabled            bool     `json:"enabled"`
}

type ManagedCommand struct {
	CommandName string `json:"command_name"`
	CommandLine string `json:"command_line"`
}

type ManagedContact struct {
	ContactName string `json:"contact_name"`
	Alias       string `json:"alias"`
	Email       string `json:"email"`
}

type ManagedHostgroup struct {
	GroupName string   `json:"group_name"`
	Alias     string   `json:"alias"`
	Members   []string `json:"members,omitempty"`
}

type ManagedServicegroup struct {
	GroupName string `json:"group_name"`
	Alias     string `json:"alias"`
}

type TemplateService struct {
	ServiceDescription string   `json:"service_description"`
	CheckCommand       string   `json:"check_command"`
	CheckInterval      int      `json:"check_interval"`
	RetryInterval      int      `json:"retry_interval"`
	MaxCheckAttempts   int      `json:"max_check_attempts"`
	CheckPeriod        string   `json:"check_period"`
	Contacts           string   `json:"contacts"`
	Servicegroups      []string `json:"servicegroups,omitempty"`
}

type ServiceTemplate struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Services    []TemplateService `json:"services"`
}

type ManagedConfig struct {
	Hosts         []ManagedHost         `json:"hosts"`
	Services      []ManagedService      `json:"services"`
	Commands      []ManagedCommand      `json:"commands"`
	Contacts      []ManagedContact      `json:"contacts"`
	Hostgroups    []ManagedHostgroup    `json:"hostgroups"`
	Servicegroups []ManagedServicegroup `json:"servicegroups"`
	Templates     []ServiceTemplate     `json:"templates"`
}

type ConfigBackupInfo struct {
	Name      string `json:"name"`
	Timestamp string `json:"timestamp"`
	SizeBytes int64  `json:"size_bytes"`
}

type AuditEntry struct {
	Time   string `json:"time"`
	Action string `json:"action"`
	Target string `json:"target"`
	Detail string `json:"detail,omitempty"`
}

type ConfigStore struct {
	mu             sync.Mutex
	managedDir     string
	nagiosBin      string
	nagiosCfg      string
	cmdPipePath    string
	cfg            ManagedConfig
	committedCfg   ManagedConfig
	pendingChanges bool
}

type ServiceRef struct {
	HostName           string `json:"host_name"`
	ServiceDescription string `json:"service_description"`
}

type DiffEntry struct {
	Kind    string   `json:"kind"`              // host, service, command, contact, hostgroup, servicegroup
	ID      string   `json:"id"`                // e.g. "web-01" or "web-01::HTTP"
	Label   string   `json:"label"`             // human-friendly label
	Status  string   `json:"status"`            // added, modified, deleted
	Changes []string `json:"changes,omitempty"` // changed field names for modified
}

type ConfigDiff struct {
	Pending  bool        `json:"pending"`
	Added    int         `json:"added"`
	Modified int         `json:"modified"`
	Deleted  int         `json:"deleted"`
	Total    int         `json:"total"`
	Entries  []DiffEntry `json:"entries"`
}

var managedCfgFilenames = []string{
	"encore-commands.cfg",
	"encore-contacts.cfg",
	"encore-groups.cfg",
	"encore-hosts.cfg",
	"encore-services.cfg",
}

func NewConfigStore(managedDir, nagiosBin, nagiosCfg, cmdPipePath string) (*ConfigStore, error) {
	cs := &ConfigStore{
		managedDir:  managedDir,
		nagiosBin:   nagiosBin,
		nagiosCfg:   nagiosCfg,
		cmdPipePath: cmdPipePath,
		cfg: ManagedConfig{
			Hosts:         []ManagedHost{},
			Services:      []ManagedService{},
			Commands:      []ManagedCommand{},
			Contacts:      []ManagedContact{},
			Hostgroups:    []ManagedHostgroup{},
			Servicegroups: []ManagedServicegroup{},
		},
	}
	if managedDir == "" {
		return cs, nil
	}
	if err := os.MkdirAll(managedDir, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(managedDir, "backups"), 0o755); err != nil {
		return nil, err
	}
	jsonPath := filepath.Join(managedDir, "encore-managed.json")
	if raw, err := os.ReadFile(jsonPath); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &cs.cfg)
	}
	cs.ensureSlices()
	committedPath := filepath.Join(managedDir, "encore-committed.json")
	if raw, err := os.ReadFile(committedPath); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &cs.committedCfg)
	} else {
		cs.committedCfg = cloneManagedConfig(cs.cfg)
	}
	if cs.diffLocked().Total > 0 {
		cs.pendingChanges = true
	}
	return cs, nil
}

func cloneManagedConfig(src ManagedConfig) ManagedConfig {
	raw, _ := json.Marshal(src)
	var dst ManagedConfig
	_ = json.Unmarshal(raw, &dst)
	return dst
}

func (cs *ConfigStore) saveCommittedLocked() error {
	if cs.managedDir == "" {
		return nil
	}
	raw, err := json.MarshalIndent(cs.committedCfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(cs.managedDir, ".encore-committed.json.tmp")
	dst := filepath.Join(cs.managedDir, "encore-committed.json")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func (cs *ConfigStore) ensureSlices() {
	if cs.cfg.Hosts == nil {
		cs.cfg.Hosts = []ManagedHost{}
	}
	if cs.cfg.Services == nil {
		cs.cfg.Services = []ManagedService{}
	}
	if cs.cfg.Commands == nil {
		cs.cfg.Commands = []ManagedCommand{}
	}
	if cs.cfg.Contacts == nil {
		cs.cfg.Contacts = []ManagedContact{}
	}
	if cs.cfg.Hostgroups == nil {
		cs.cfg.Hostgroups = []ManagedHostgroup{}
	}
	if cs.cfg.Servicegroups == nil {
		cs.cfg.Servicegroups = []ManagedServicegroup{}
	}
	if cs.cfg.Templates == nil {
		cs.cfg.Templates = defaultStarterTemplates()
	}
}

func defaultStarterTemplates() []ServiceTemplate {
	return []ServiceTemplate{
		{
			Name:        "linux-ncpa-basic",
			Description: "Standard Linux server checks via NCPA (CPU, RAM, Disk /, Processes)",
			Services: []TemplateService{
				{ServiceDescription: "NCPA CPU", CheckCommand: "check_ncpa!cpu/percent!-w 80 -c 90", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
				{ServiceDescription: "NCPA RAM", CheckCommand: "check_ncpa!memory/virtual!-w 80 -c 90", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
				{ServiceDescription: "NCPA Disk /", CheckCommand: "check_ncpa!disk/logical/|/used_percent!-w 80 -c 90", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
				{ServiceDescription: "NCPA Procs", CheckCommand: "check_ncpa!processes!-w 250 -c 400", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
			},
		},
		{
			Name:        "windows-ncpa-basic",
			Description: "Standard Windows server checks via NCPA (CPU, RAM, Disk C:)",
			Services: []TemplateService{
				{ServiceDescription: "NCPA CPU", CheckCommand: "check_ncpa!cpu/percent!-w 80 -c 90", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
				{ServiceDescription: "NCPA RAM", CheckCommand: "check_ncpa!memory/virtual!-w 80 -c 90", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
				{ServiceDescription: "NCPA Disk C:", CheckCommand: "check_ncpa!disk/logical/C:|/used_percent!-w 80 -c 90", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
			},
		},
		{
			Name:        "web-https-stack",
			Description: "Web server HTTP, HTTPS & PING availability checks",
			Services: []TemplateService{
				{ServiceDescription: "PING", CheckCommand: "check_ping!100.0,20%!500.0,60%", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
				{ServiceDescription: "HTTP", CheckCommand: "check_http", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
				{ServiceDescription: "HTTPS 443", CheckCommand: "check_tcp!443", CheckInterval: 5, RetryInterval: 1, MaxCheckAttempts: 3, CheckPeriod: "24x7"},
			},
		},
	}
}

func (cs *ConfigStore) UpsertTemplate(t ServiceTemplate) error {
	if err := sanitizeName(t.Name); err != nil {
		return fmt.Errorf("template name: %w", err)
	}
	if err := sanitizeVal(t.Description); err != nil {
		return err
	}
	if len(t.Services) == 0 {
		return errors.New("template must contain at least one service")
	}
	for i := range t.Services {
		s := &t.Services[i]
		if err := sanitizeName(s.ServiceDescription); err != nil {
			return fmt.Errorf("service %d description: %w", i+1, err)
		}
		if strings.TrimSpace(s.CheckCommand) == "" {
			return fmt.Errorf("service %s: check_command is required", s.ServiceDescription)
		}
		if err := sanitizeVal(s.CheckCommand); err != nil {
			return err
		}
		if s.CheckInterval <= 0 {
			s.CheckInterval = 5
		}
		if s.RetryInterval <= 0 {
			s.RetryInterval = 1
		}
		if s.MaxCheckAttempts <= 0 {
			s.MaxCheckAttempts = 3
		}
		if s.CheckPeriod == "" {
			s.CheckPeriod = "24x7"
		}
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()
	found := false
	for i := range cs.cfg.Templates {
		if cs.cfg.Templates[i].Name == t.Name {
			cs.cfg.Templates[i] = t
			found = true
			break
		}
	}
	if !found {
		cs.cfg.Templates = append(cs.cfg.Templates, t)
	}
	sort.Slice(cs.cfg.Templates, func(i, j int) bool { return cs.cfg.Templates[i].Name < cs.cfg.Templates[j].Name })
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("upsert_template", t.Name, fmt.Sprintf("%d services", len(t.Services)))
	return nil
}

func (cs *ConfigStore) DeleteTemplate(name string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	out := cs.cfg.Templates[:0]
	removed := false
	for _, t := range cs.cfg.Templates {
		if t.Name == name {
			removed = true
			continue
		}
		out = append(out, t)
	}
	if !removed {
		return fmt.Errorf("template %q not found", name)
	}
	cs.cfg.Templates = out
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("delete_template", name, "")
	return nil
}

func (cs *ConfigStore) SaveTemplateFromHost(hostName, tplName, desc string) (int, error) {
	if err := sanitizeName(tplName); err != nil {
		return 0, fmt.Errorf("template name: %w", err)
	}
	cs.mu.Lock()
	var svcs []TemplateService
	for _, s := range cs.cfg.Services {
		if s.HostName == hostName {
			svcs = append(svcs, TemplateService{
				ServiceDescription: s.ServiceDescription,
				CheckCommand:       s.CheckCommand,
				CheckInterval:      s.CheckInterval,
				RetryInterval:      s.RetryInterval,
				MaxCheckAttempts:   s.MaxCheckAttempts,
				CheckPeriod:        s.CheckPeriod,
				Contacts:           s.Contacts,
				Servicegroups:      append([]string(nil), s.Servicegroups...),
			})
		}
	}
	cs.mu.Unlock()
	if len(svcs) == 0 {
		return 0, fmt.Errorf("host %q has no managed services to save as template", hostName)
	}
	if desc == "" {
		desc = fmt.Sprintf("Cloned from host %s (%d services)", hostName, len(svcs))
	}
	if err := cs.UpsertTemplate(ServiceTemplate{Name: tplName, Description: desc, Services: svcs}); err != nil {
		return 0, err
	}
	return len(svcs), nil
}

func (cs *ConfigStore) ApplyTemplate(tplName string, hostNames []string, overwrite bool) (int, int, error) {
	if len(hostNames) == 0 {
		return 0, 0, errors.New("at least one target host is required")
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()

	var tpl *ServiceTemplate
	for i := range cs.cfg.Templates {
		if cs.cfg.Templates[i].Name == tplName {
			tpl = &cs.cfg.Templates[i]
			break
		}
	}
	if tpl == nil {
		return 0, 0, fmt.Errorf("template %q not found", tplName)
	}

	hostExists := make(map[string]bool, len(cs.cfg.Hosts))
	for _, h := range cs.cfg.Hosts {
		hostExists[h.Name] = true
	}
	existingIdx := make(map[string]int, len(cs.cfg.Services))
	for i, s := range cs.cfg.Services {
		existingIdx[s.HostName+"\x00"+s.ServiceDescription] = i
	}

	added, skipped := 0, 0
	for _, hn := range hostNames {
		if !hostExists[hn] {
			continue
		}
		for _, ts := range tpl.Services {
			k := hn + "\x00" + ts.ServiceDescription
			ms := ManagedService{
				HostName:           hn,
				ServiceDescription: ts.ServiceDescription,
				CheckCommand:       ts.CheckCommand,
				CheckInterval:      ts.CheckInterval,
				RetryInterval:      ts.RetryInterval,
				MaxCheckAttempts:   ts.MaxCheckAttempts,
				CheckPeriod:        ts.CheckPeriod,
				Contacts:           ts.Contacts,
				Servicegroups:      append([]string(nil), ts.Servicegroups...),
				Enabled:            true,
			}
			if idx, ok := existingIdx[k]; ok {
				if overwrite {
					cs.cfg.Services[idx] = ms
					added++
				} else {
					skipped++
				}
			} else {
				existingIdx[k] = len(cs.cfg.Services)
				cs.cfg.Services = append(cs.cfg.Services, ms)
				added++
			}
		}
	}

	if added > 0 {
		sort.Slice(cs.cfg.Services, func(i, j int) bool {
			if cs.cfg.Services[i].HostName != cs.cfg.Services[j].HostName {
				return cs.cfg.Services[i].HostName < cs.cfg.Services[j].HostName
			}
			return cs.cfg.Services[i].ServiceDescription < cs.cfg.Services[j].ServiceDescription
		})
		cs.pendingChanges = true
		if err := cs.saveJSONLocked(); err != nil {
			return added, skipped, err
		}
		cs.RecordAudit("apply_template", tplName, fmt.Sprintf("hosts=%d added=%d skipped=%d", len(hostNames), added, skipped))
	}
	return added, skipped, nil
}

func (cs *ConfigStore) BulkHostsAction(action string, names []string) (int, error) {
	if len(names) == 0 {
		return 0, errors.New("no hosts selected")
	}
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	affected := 0
	switch action {
	case "enable", "disable":
		en := action == "enable"
		for i := range cs.cfg.Hosts {
			if set[cs.cfg.Hosts[i].Name] {
				cs.cfg.Hosts[i].Enabled = en
				affected++
			}
		}
	case "delete":
		newHosts := cs.cfg.Hosts[:0]
		for _, h := range cs.cfg.Hosts {
			if set[h.Name] {
				affected++
				continue
			}
			newHosts = append(newHosts, h)
		}
		cs.cfg.Hosts = newHosts
		newSvcs := cs.cfg.Services[:0]
		for _, s := range cs.cfg.Services {
			if set[s.HostName] {
				continue
			}
			newSvcs = append(newSvcs, s)
		}
		cs.cfg.Services = newSvcs
	default:
		return 0, fmt.Errorf("unknown bulk action %q", action)
	}
	if affected > 0 {
		cs.pendingChanges = true
		if err := cs.saveJSONLocked(); err != nil {
			return affected, err
		}
		cs.RecordAudit("bulk_hosts_"+action, fmt.Sprintf("%d hosts", affected), strings.Join(names, ","))
	}
	return affected, nil
}

func (cs *ConfigStore) BulkServicesAction(action string, items []ServiceRef) (int, error) {
	if len(items) == 0 {
		return 0, errors.New("no services selected")
	}
	set := make(map[string]bool, len(items))
	for _, it := range items {
		set[it.HostName+"\x00"+it.ServiceDescription] = true
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	affected := 0
	switch action {
	case "enable", "disable":
		en := action == "enable"
		for i := range cs.cfg.Services {
			k := cs.cfg.Services[i].HostName + "\x00" + cs.cfg.Services[i].ServiceDescription
			if set[k] {
				cs.cfg.Services[i].Enabled = en
				affected++
			}
		}
	case "delete":
		next := cs.cfg.Services[:0]
		for _, s := range cs.cfg.Services {
			if set[s.HostName+"\x00"+s.ServiceDescription] {
				affected++
				continue
			}
			next = append(next, s)
		}
		cs.cfg.Services = next
	default:
		return 0, fmt.Errorf("unknown bulk action %q", action)
	}
	if affected > 0 {
		cs.pendingChanges = true
		if err := cs.saveJSONLocked(); err != nil {
			return affected, err
		}
		cs.RecordAudit("bulk_services_"+action, fmt.Sprintf("%d services", affected), "")
	}
	return affected, nil
}

func sliceEq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (cs *ConfigStore) diffLocked() ConfigDiff {
	out := ConfigDiff{Entries: []DiffEntry{}}
	addEntry := func(e DiffEntry) {
		out.Entries = append(out.Entries, e)
		switch e.Status {
		case "added":
			out.Added++
		case "modified":
			out.Modified++
		case "deleted":
			out.Deleted++
		}
		out.Total++
	}

	// Hosts
	oldH := make(map[string]ManagedHost, len(cs.committedCfg.Hosts))
	for _, h := range cs.committedCfg.Hosts {
		oldH[h.Name] = h
	}
	newH := make(map[string]ManagedHost, len(cs.cfg.Hosts))
	for _, h := range cs.cfg.Hosts {
		newH[h.Name] = h
		if prev, ok := oldH[h.Name]; !ok {
			addEntry(DiffEntry{Kind: "host", ID: h.Name, Label: h.Name + " (" + h.Address + ")", Status: "added"})
		} else {
			var ch []string
			if prev.Address != h.Address {
				ch = append(ch, "address")
			}
			if prev.Alias != h.Alias {
				ch = append(ch, "alias")
			}
			if prev.CheckCommand != h.CheckCommand {
				ch = append(ch, "check_command")
			}
			if prev.CheckInterval != h.CheckInterval {
				ch = append(ch, "check_interval")
			}
			if prev.MaxCheckAttempts != h.MaxCheckAttempts {
				ch = append(ch, "max_check_attempts")
			}
			if prev.Contacts != h.Contacts {
				ch = append(ch, "contacts")
			}
			if !sliceEq(prev.Hostgroups, h.Hostgroups) {
				ch = append(ch, "hostgroups")
			}
			if prev.Enabled != h.Enabled {
				ch = append(ch, "enabled")
			}
			if len(ch) > 0 {
				addEntry(DiffEntry{Kind: "host", ID: h.Name, Label: h.Name, Status: "modified", Changes: ch})
			}
		}
	}
	for _, h := range cs.committedCfg.Hosts {
		if _, ok := newH[h.Name]; !ok {
			addEntry(DiffEntry{Kind: "host", ID: h.Name, Label: h.Name + " (" + h.Address + ")", Status: "deleted"})
		}
	}

	// Services
	oldS := make(map[string]ManagedService, len(cs.committedCfg.Services))
	for _, s := range cs.committedCfg.Services {
		oldS[s.HostName+"::"+s.ServiceDescription] = s
	}
	newS := make(map[string]ManagedService, len(cs.cfg.Services))
	for _, s := range cs.cfg.Services {
		id := s.HostName + "::" + s.ServiceDescription
		newS[id] = s
		if prev, ok := oldS[id]; !ok {
			addEntry(DiffEntry{Kind: "service", ID: id, Label: s.HostName + " / " + s.ServiceDescription, Status: "added"})
		} else {
			var ch []string
			if prev.CheckCommand != s.CheckCommand {
				ch = append(ch, "check_command")
			}
			if prev.CheckInterval != s.CheckInterval {
				ch = append(ch, "check_interval")
			}
			if prev.MaxCheckAttempts != s.MaxCheckAttempts {
				ch = append(ch, "max_check_attempts")
			}
			if prev.Contacts != s.Contacts {
				ch = append(ch, "contacts")
			}
			if !sliceEq(prev.Servicegroups, s.Servicegroups) {
				ch = append(ch, "servicegroups")
			}
			if prev.Enabled != s.Enabled {
				ch = append(ch, "enabled")
			}
			if len(ch) > 0 {
				addEntry(DiffEntry{Kind: "service", ID: id, Label: s.HostName + " / " + s.ServiceDescription, Status: "modified", Changes: ch})
			}
		}
	}
	for _, s := range cs.committedCfg.Services {
		id := s.HostName + "::" + s.ServiceDescription
		if _, ok := newS[id]; !ok {
			addEntry(DiffEntry{Kind: "service", ID: id, Label: s.HostName + " / " + s.ServiceDescription, Status: "deleted"})
		}
	}

	// Commands
	oldC := make(map[string]ManagedCommand, len(cs.committedCfg.Commands))
	for _, c := range cs.committedCfg.Commands {
		oldC[c.CommandName] = c
	}
	newC := make(map[string]ManagedCommand, len(cs.cfg.Commands))
	for _, c := range cs.cfg.Commands {
		newC[c.CommandName] = c
		if prev, ok := oldC[c.CommandName]; !ok {
			addEntry(DiffEntry{Kind: "command", ID: c.CommandName, Label: c.CommandName, Status: "added"})
		} else if prev.CommandLine != c.CommandLine {
			addEntry(DiffEntry{Kind: "command", ID: c.CommandName, Label: c.CommandName, Status: "modified", Changes: []string{"command_line"}})
		}
	}
	for _, c := range cs.committedCfg.Commands {
		if _, ok := newC[c.CommandName]; !ok {
			addEntry(DiffEntry{Kind: "command", ID: c.CommandName, Label: c.CommandName, Status: "deleted"})
		}
	}

	// Contacts
	oldCt := make(map[string]ManagedContact, len(cs.committedCfg.Contacts))
	for _, c := range cs.committedCfg.Contacts {
		oldCt[c.ContactName] = c
	}
	newCt := make(map[string]ManagedContact, len(cs.cfg.Contacts))
	for _, c := range cs.cfg.Contacts {
		newCt[c.ContactName] = c
		if prev, ok := oldCt[c.ContactName]; !ok {
			addEntry(DiffEntry{Kind: "contact", ID: c.ContactName, Label: c.ContactName, Status: "added"})
		} else if prev.Alias != c.Alias || prev.Email != c.Email {
			addEntry(DiffEntry{Kind: "contact", ID: c.ContactName, Label: c.ContactName, Status: "modified", Changes: []string{"alias/email"}})
		}
	}
	for _, c := range cs.committedCfg.Contacts {
		if _, ok := newCt[c.ContactName]; !ok {
			addEntry(DiffEntry{Kind: "contact", ID: c.ContactName, Label: c.ContactName, Status: "deleted"})
		}
	}

	// Hostgroups
	oldHG := make(map[string]ManagedHostgroup, len(cs.committedCfg.Hostgroups))
	for _, g := range cs.committedCfg.Hostgroups {
		oldHG[g.GroupName] = g
	}
	newHG := make(map[string]ManagedHostgroup, len(cs.cfg.Hostgroups))
	for _, g := range cs.cfg.Hostgroups {
		newHG[g.GroupName] = g
		if prev, ok := oldHG[g.GroupName]; !ok {
			addEntry(DiffEntry{Kind: "hostgroup", ID: g.GroupName, Label: g.GroupName, Status: "added"})
		} else if prev.Alias != g.Alias || !sliceEq(prev.Members, g.Members) {
			addEntry(DiffEntry{Kind: "hostgroup", ID: g.GroupName, Label: g.GroupName, Status: "modified", Changes: []string{"alias/members"}})
		}
	}
	for _, g := range cs.committedCfg.Hostgroups {
		if _, ok := newHG[g.GroupName]; !ok {
			addEntry(DiffEntry{Kind: "hostgroup", ID: g.GroupName, Label: g.GroupName, Status: "deleted"})
		}
	}

	// Servicegroups
	oldSG := make(map[string]ManagedServicegroup, len(cs.committedCfg.Servicegroups))
	for _, g := range cs.committedCfg.Servicegroups {
		oldSG[g.GroupName] = g
	}
	newSG := make(map[string]ManagedServicegroup, len(cs.cfg.Servicegroups))
	for _, g := range cs.cfg.Servicegroups {
		newSG[g.GroupName] = g
		if prev, ok := oldSG[g.GroupName]; !ok {
			addEntry(DiffEntry{Kind: "servicegroup", ID: g.GroupName, Label: g.GroupName, Status: "added"})
		} else if prev.Alias != g.Alias {
			addEntry(DiffEntry{Kind: "servicegroup", ID: g.GroupName, Label: g.GroupName, Status: "modified", Changes: []string{"alias"}})
		}
	}
	for _, g := range cs.committedCfg.Servicegroups {
		if _, ok := newSG[g.GroupName]; !ok {
			addEntry(DiffEntry{Kind: "servicegroup", ID: g.GroupName, Label: g.GroupName, Status: "deleted"})
		}
	}

	out.Pending = cs.pendingChanges || out.Total > 0
	return out
}

func (cs *ConfigStore) Diff() ConfigDiff {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.diffLocked()
}

func (cs *ConfigStore) DiscardPending() (int, error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	d := cs.diffLocked()
	// Keep Templates intact since templates are Instant Save (not staged Nagios .cfg)
	keepTpls := cs.cfg.Templates
	cs.cfg = cloneManagedConfig(cs.committedCfg)
	cs.cfg.Templates = keepTpls
	cs.ensureSlices()
	cs.pendingChanges = false
	if err := cs.saveJSONLocked(); err != nil {
		return 0, err
	}
	cs.RecordAudit("discard_pending", fmt.Sprintf("%d changes reverted", d.Total), "")
	return d.Total, nil
}

func sanitizeVal(s string) error {
	if strings.ContainsAny(s, "\r\n\x00{}") {
		return errors.New("value contains forbidden characters (newline, NUL, or braces)")
	}
	return nil
}

func sanitizeName(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return errors.New("name cannot be empty")
	}
	if strings.ContainsAny(s, "\r\n\x00{};") {
		return errors.New("name contains forbidden characters")
	}
	return nil
}

func (cs *ConfigStore) saveJSONLocked() error {
	if cs.managedDir == "" {
		return nil
	}
	raw, err := json.MarshalIndent(cs.cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(cs.managedDir, ".encore-managed.json.tmp")
	dst := filepath.Join(cs.managedDir, "encore-managed.json")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func (cs *ConfigStore) RecordAudit(action, target, detail string) {
	if cs.managedDir == "" {
		return
	}
	entry := AuditEntry{
		Time:   time.Now().UTC().Format(time.RFC3339),
		Action: action,
		Target: target,
		Detail: detail,
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(cs.managedDir, "encore-audit.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

func (cs *ConfigStore) ReadAudit(limit int) []AuditEntry {
	if cs.managedDir == "" {
		return []AuditEntry{}
	}
	raw, err := os.ReadFile(filepath.Join(cs.managedDir, "encore-audit.log"))
	if err != nil {
		return []AuditEntry{}
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	out := make([]AuditEntry, 0, len(lines))
	for i := len(lines) - 1; i >= 0 && len(out) < limit; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		var e AuditEntry
		if json.Unmarshal([]byte(lines[i]), &e) == nil {
			out = append(out, e)
		}
	}
	return out
}

func (cs *ConfigStore) Snapshot() (ManagedConfig, bool, bool) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.cfg, cs.pendingChanges, cs.managedDir != ""
}

func (cs *ConfigStore) UpsertHost(h ManagedHost) error {
	if err := sanitizeName(h.Name); err != nil {
		return fmt.Errorf("host name: %w", err)
	}
	if err := sanitizeName(h.Address); err != nil {
		return fmt.Errorf("address: %w", err)
	}
	if err := sanitizeVal(h.Alias); err != nil {
		return err
	}
	if err := sanitizeVal(h.CheckCommand); err != nil {
		return err
	}
	if h.Alias == "" {
		h.Alias = h.Name
	}
	if h.CheckCommand == "" {
		h.CheckCommand = "check-host-alive"
	}
	if h.CheckInterval <= 0 {
		h.CheckInterval = 5
	}
	if h.RetryInterval <= 0 {
		h.RetryInterval = 1
	}
	if h.MaxCheckAttempts <= 0 {
		h.MaxCheckAttempts = 3
	}
	if h.CheckPeriod == "" {
		h.CheckPeriod = "24x7"
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()
	found := false
	for i := range cs.cfg.Hosts {
		if cs.cfg.Hosts[i].Name == h.Name {
			cs.cfg.Hosts[i] = h
			found = true
			break
		}
	}
	if !found {
		cs.cfg.Hosts = append(cs.cfg.Hosts, h)
	}
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("upsert_host", h.Name, h.Address)
	return nil
}

func (cs *ConfigStore) DeleteHost(name string, cascadeServices bool) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	next := make([]ManagedHost, 0, len(cs.cfg.Hosts))
	removed := false
	for _, h := range cs.cfg.Hosts {
		if h.Name == name {
			removed = true
			continue
		}
		next = append(next, h)
	}
	if !removed {
		return fmt.Errorf("host %q not found in managed config", name)
	}
	cs.cfg.Hosts = next
	if cascadeServices {
		svcs := make([]ManagedService, 0, len(cs.cfg.Services))
		for _, s := range cs.cfg.Services {
			if s.HostName == name {
				continue
			}
			svcs = append(svcs, s)
		}
		cs.cfg.Services = svcs
	}
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("delete_host", name, fmt.Sprintf("cascade=%v", cascadeServices))
	return nil
}

func (cs *ConfigStore) CloneHost(sourceName, newName, newAlias, newAddress string, includeServices bool) (int, error) {
	if err := sanitizeName(newName); err != nil {
		return 0, fmt.Errorf("new_name: %w", err)
	}
	if err := sanitizeName(newAddress); err != nil {
		return 0, fmt.Errorf("new_address: %w", err)
	}
	if err := sanitizeVal(newAlias); err != nil {
		return 0, err
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	var src *ManagedHost
	for i := range cs.cfg.Hosts {
		if cs.cfg.Hosts[i].Name == newName {
			return 0, fmt.Errorf("host %q already exists", newName)
		}
		if cs.cfg.Hosts[i].Name == sourceName {
			h := cs.cfg.Hosts[i]
			src = &h
		}
	}
	if src == nil {
		return 0, fmt.Errorf("source host %q not found in managed config", sourceName)
	}

	cloned := *src
	cloned.Name = newName
	cloned.Address = newAddress
	if newAlias != "" {
		cloned.Alias = newAlias
	} else {
		cloned.Alias = newName
	}
	if len(src.Hostgroups) > 0 {
		cloned.Hostgroups = append([]string(nil), src.Hostgroups...)
	}
	cs.cfg.Hosts = append(cs.cfg.Hosts, cloned)

	clonedServices := 0
	if includeServices {
		existing := make([]ManagedService, len(cs.cfg.Services))
		copy(existing, cs.cfg.Services)
		for _, s := range existing {
			if s.HostName != sourceName {
				continue
			}
			sc := s
			sc.HostName = newName
			if len(s.Servicegroups) > 0 {
				sc.Servicegroups = append([]string(nil), s.Servicegroups...)
			}
			cs.cfg.Services = append(cs.cfg.Services, sc)
			clonedServices++
		}
	}

	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return 0, err
	}
	cs.RecordAudit("clone_host", newName, fmt.Sprintf("from=%s services=%d", sourceName, clonedServices))
	return clonedServices, nil
}

func (cs *ConfigStore) UpsertService(s ManagedService) error {
	if err := sanitizeName(s.HostName); err != nil {
		return fmt.Errorf("host_name: %w", err)
	}
	if err := sanitizeName(s.ServiceDescription); err != nil {
		return fmt.Errorf("service_description: %w", err)
	}
	if err := sanitizeName(s.CheckCommand); err != nil {
		return fmt.Errorf("check_command: %w", err)
	}
	if s.CheckInterval <= 0 {
		s.CheckInterval = 5
	}
	if s.RetryInterval <= 0 {
		s.RetryInterval = 1
	}
	if s.MaxCheckAttempts <= 0 {
		s.MaxCheckAttempts = 3
	}
	if s.CheckPeriod == "" {
		s.CheckPeriod = "24x7"
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()
	found := false
	for i := range cs.cfg.Services {
		if cs.cfg.Services[i].HostName == s.HostName && cs.cfg.Services[i].ServiceDescription == s.ServiceDescription {
			cs.cfg.Services[i] = s
			found = true
			break
		}
	}
	if !found {
		cs.cfg.Services = append(cs.cfg.Services, s)
	}
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("upsert_service", s.HostName+"/"+s.ServiceDescription, s.CheckCommand)
	return nil
}

func (cs *ConfigStore) DeleteService(hostName, desc string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	next := make([]ManagedService, 0, len(cs.cfg.Services))
	removed := false
	for _, s := range cs.cfg.Services {
		if s.HostName == hostName && s.ServiceDescription == desc {
			removed = true
			continue
		}
		next = append(next, s)
	}
	if !removed {
		return fmt.Errorf("service %q/%q not found", hostName, desc)
	}
	cs.cfg.Services = next
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("delete_service", hostName+"/"+desc, "")
	return nil
}

func (cs *ConfigStore) CloneService(srcHost, srcDesc, dstHost, dstDesc string) error {
	if err := sanitizeName(dstHost); err != nil {
		return err
	}
	if err := sanitizeName(dstDesc); err != nil {
		return err
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	var src *ManagedService
	for i := range cs.cfg.Services {
		s := cs.cfg.Services[i]
		if s.HostName == dstHost && s.ServiceDescription == dstDesc {
			return fmt.Errorf("service %q/%q already exists", dstHost, dstDesc)
		}
		if s.HostName == srcHost && s.ServiceDescription == srcDesc {
			sc := s
			src = &sc
		}
	}
	if src == nil {
		return fmt.Errorf("source service %q/%q not found", srcHost, srcDesc)
	}
	cloned := *src
	cloned.HostName = dstHost
	cloned.ServiceDescription = dstDesc
	if len(src.Servicegroups) > 0 {
		cloned.Servicegroups = append([]string(nil), src.Servicegroups...)
	}
	cs.cfg.Services = append(cs.cfg.Services, cloned)
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("clone_service", dstHost+"/"+dstDesc, "from="+srcHost+"/"+srcDesc)
	return nil
}

func (cs *ConfigStore) UpsertCommand(c ManagedCommand) error {
	if err := sanitizeName(c.CommandName); err != nil {
		return err
	}
	if err := sanitizeName(c.CommandLine); err != nil {
		return err
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	found := false
	for i := range cs.cfg.Commands {
		if cs.cfg.Commands[i].CommandName == c.CommandName {
			cs.cfg.Commands[i] = c
			found = true
			break
		}
	}
	if !found {
		cs.cfg.Commands = append(cs.cfg.Commands, c)
	}
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("upsert_command", c.CommandName, "")
	return nil
}

func (cs *ConfigStore) DeleteCommand(name string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	next := make([]ManagedCommand, 0, len(cs.cfg.Commands))
	removed := false
	for _, c := range cs.cfg.Commands {
		if c.CommandName == name {
			removed = true
			continue
		}
		next = append(next, c)
	}
	if !removed {
		return fmt.Errorf("command %q not found", name)
	}
	cs.cfg.Commands = next
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("delete_command", name, "")
	return nil
}

func (cs *ConfigStore) UpsertContact(c ManagedContact) error {
	if err := sanitizeName(c.ContactName); err != nil {
		return err
	}
	if err := sanitizeVal(c.Alias); err != nil {
		return err
	}
	if err := sanitizeVal(c.Email); err != nil {
		return err
	}
	if c.Alias == "" {
		c.Alias = c.ContactName
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	found := false
	for i := range cs.cfg.Contacts {
		if cs.cfg.Contacts[i].ContactName == c.ContactName {
			cs.cfg.Contacts[i] = c
			found = true
			break
		}
	}
	if !found {
		cs.cfg.Contacts = append(cs.cfg.Contacts, c)
	}
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("upsert_contact", c.ContactName, c.Email)
	return nil
}

func (cs *ConfigStore) DeleteContact(name string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	next := make([]ManagedContact, 0, len(cs.cfg.Contacts))
	removed := false
	for _, c := range cs.cfg.Contacts {
		if c.ContactName == name {
			removed = true
			continue
		}
		next = append(next, c)
	}
	if !removed {
		return fmt.Errorf("contact %q not found", name)
	}
	cs.cfg.Contacts = next
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("delete_contact", name, "")
	return nil
}

func (cs *ConfigStore) UpsertHostgroup(hg ManagedHostgroup) error {
	if err := sanitizeName(hg.GroupName); err != nil {
		return err
	}
	if err := sanitizeVal(hg.Alias); err != nil {
		return err
	}
	if hg.Alias == "" {
		hg.Alias = hg.GroupName
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	found := false
	for i := range cs.cfg.Hostgroups {
		if cs.cfg.Hostgroups[i].GroupName == hg.GroupName {
			cs.cfg.Hostgroups[i] = hg
			found = true
			break
		}
	}
	if !found {
		cs.cfg.Hostgroups = append(cs.cfg.Hostgroups, hg)
	}
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("upsert_hostgroup", hg.GroupName, "")
	return nil
}

func (cs *ConfigStore) DeleteHostgroup(name string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	next := make([]ManagedHostgroup, 0, len(cs.cfg.Hostgroups))
	removed := false
	for _, g := range cs.cfg.Hostgroups {
		if g.GroupName == name {
			removed = true
			continue
		}
		next = append(next, g)
	}
	if !removed {
		return fmt.Errorf("hostgroup %q not found", name)
	}
	cs.cfg.Hostgroups = next
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("delete_hostgroup", name, "")
	return nil
}

func (cs *ConfigStore) UpsertServicegroup(sg ManagedServicegroup) error {
	if err := sanitizeName(sg.GroupName); err != nil {
		return err
	}
	if err := sanitizeVal(sg.Alias); err != nil {
		return err
	}
	if sg.Alias == "" {
		sg.Alias = sg.GroupName
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	found := false
	for i := range cs.cfg.Servicegroups {
		if cs.cfg.Servicegroups[i].GroupName == sg.GroupName {
			cs.cfg.Servicegroups[i] = sg
			found = true
			break
		}
	}
	if !found {
		cs.cfg.Servicegroups = append(cs.cfg.Servicegroups, sg)
	}
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("upsert_servicegroup", sg.GroupName, "")
	return nil
}

func (cs *ConfigStore) DeleteServicegroup(name string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	next := make([]ManagedServicegroup, 0, len(cs.cfg.Servicegroups))
	removed := false
	for _, g := range cs.cfg.Servicegroups {
		if g.GroupName == name {
			removed = true
			continue
		}
		next = append(next, g)
	}
	if !removed {
		return fmt.Errorf("servicegroup %q not found", name)
	}
	cs.cfg.Servicegroups = next
	cs.pendingChanges = true
	if err := cs.saveJSONLocked(); err != nil {
		return err
	}
	cs.RecordAudit("delete_servicegroup", name, "")
	return nil
}

func (cs *ConfigStore) renderFilesLocked() map[string]string {
	files := make(map[string]string, len(managedCfgFilenames))

	// Commands
	var b bytes.Buffer
	b.WriteString("# Managed by Encore Dashboard — do not edit manually\n")
	for _, c := range cs.cfg.Commands {
		fmt.Fprintf(&b, "define command {\n    command_name    %s\n    command_line    %s\n}\n\n",
			c.CommandName, c.CommandLine)
	}
	files["encore-commands.cfg"] = b.String()

	// Contacts
	b.Reset()
	b.WriteString("# Managed by Encore Dashboard — do not edit manually\n")
	for _, c := range cs.cfg.Contacts {
		fmt.Fprintf(&b, "define contact {\n    contact_name                    %s\n    alias                           %s\n",
			c.ContactName, c.Alias)
		if c.Email != "" {
			fmt.Fprintf(&b, "    email                           %s\n", c.Email)
		}
		b.WriteString("    host_notifications_enabled      0\n    service_notifications_enabled   0\n")
		b.WriteString("    host_notification_period        24x7\n    service_notification_period     24x7\n")
		b.WriteString("    host_notification_options       n\n    service_notification_options    n\n")
		b.WriteString("    host_notification_commands      check-host-alive\n    service_notification_commands   check-host-alive\n}\n\n")
	}
	files["encore-contacts.cfg"] = b.String()

	// Groups
	b.Reset()
	b.WriteString("# Managed by Encore Dashboard — do not edit manually\n")
	for _, g := range cs.cfg.Hostgroups {
		fmt.Fprintf(&b, "define hostgroup {\n    hostgroup_name  %s\n    alias           %s\n", g.GroupName, g.Alias)
		if len(g.Members) > 0 {
			fmt.Fprintf(&b, "    members         %s\n", strings.Join(g.Members, ","))
		}
		b.WriteString("}\n\n")
	}
	for _, g := range cs.cfg.Servicegroups {
		fmt.Fprintf(&b, "define servicegroup {\n    servicegroup_name   %s\n    alias               %s\n}\n\n",
			g.GroupName, g.Alias)
	}
	files["encore-groups.cfg"] = b.String()

	// Hosts
	b.Reset()
	b.WriteString("# Managed by Encore Dashboard — do not edit manually\n")
	for _, h := range cs.cfg.Hosts {
		if !h.Enabled {
			continue
		}
		fmt.Fprintf(&b, "define host {\n    host_name               %s\n    alias                   %s\n    address                 %s\n    check_command           %s\n    max_check_attempts      %d\n    check_interval          %d\n    retry_interval          %d\n    check_period            %s\n    notification_interval   60\n    notification_period     24x7\n",
			h.Name, h.Alias, h.Address, h.CheckCommand, h.MaxCheckAttempts, h.CheckInterval, h.RetryInterval, h.CheckPeriod)
		if h.Contacts != "" {
			fmt.Fprintf(&b, "    contacts                %s\n", h.Contacts)
		}
		if len(h.Hostgroups) > 0 {
			fmt.Fprintf(&b, "    hostgroups              %s\n", strings.Join(h.Hostgroups, ","))
		}
		b.WriteString("}\n\n")
	}
	files["encore-hosts.cfg"] = b.String()

	// Services
	b.Reset()
	b.WriteString("# Managed by Encore Dashboard — do not edit manually\n")
	for _, s := range cs.cfg.Services {
		if !s.Enabled {
			continue
		}
		fmt.Fprintf(&b, "define service {\n    host_name               %s\n    service_description     %s\n    check_command           %s\n    max_check_attempts      %d\n    check_interval          %d\n    retry_interval          %d\n    check_period            %s\n    notification_interval   60\n    notification_period     24x7\n",
			s.HostName, s.ServiceDescription, s.CheckCommand, s.MaxCheckAttempts, s.CheckInterval, s.RetryInterval, s.CheckPeriod)
		if s.Contacts != "" {
			fmt.Fprintf(&b, "    contacts                %s\n", s.Contacts)
		}
		if len(s.Servicegroups) > 0 {
			fmt.Fprintf(&b, "    servicegroups           %s\n", strings.Join(s.Servicegroups, ","))
		}
		b.WriteString("}\n\n")
	}
	files["encore-services.cfg"] = b.String()

	return files
}

func (cs *ConfigStore) writeBackupLocked() error {
	bdir := filepath.Join(cs.managedDir, "backups")
	name := fmt.Sprintf("backup-%s.json", time.Now().UTC().Format("20060102-150405"))
	raw, err := json.MarshalIndent(cs.cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(bdir, name), raw, 0o644); err != nil {
		return err
	}
	entries, _ := os.ReadDir(bdir)
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > 10 {
		_ = os.Remove(filepath.Join(bdir, names[0]))
		names = names[1:]
	}
	return nil
}

func (cs *ConfigStore) ListBackups() []ConfigBackupInfo {
	if cs.managedDir == "" {
		return []ConfigBackupInfo{}
	}
	bdir := filepath.Join(cs.managedDir, "backups")
	entries, err := os.ReadDir(bdir)
	if err != nil {
		return []ConfigBackupInfo{}
	}
	out := make([]ConfigBackupInfo, 0, len(entries))
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, ConfigBackupInfo{
			Name:      e.Name(),
			Timestamp: info.ModTime().UTC().Format(time.RFC3339),
			SizeBytes: info.Size(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out
}

func (cs *ConfigStore) Rollback(backupName string) (string, error) {
	if cs.managedDir == "" {
		return "", errors.New("managed config directory not configured")
	}
	if strings.ContainsAny(backupName, "/\\") || !strings.HasSuffix(backupName, ".json") {
		return "", errors.New("invalid backup name")
	}
	raw, err := os.ReadFile(filepath.Join(cs.managedDir, "backups", backupName))
	if err != nil {
		return "", err
	}
	var restored ManagedConfig
	if err := json.Unmarshal(raw, &restored); err != nil {
		return "", err
	}
	cs.mu.Lock()
	cs.cfg = restored
	cs.ensureSlices()
	cs.pendingChanges = true
	_ = cs.saveJSONLocked()
	cs.mu.Unlock()

	out, err := cs.ValidateAndApply(true)
	if err == nil {
		cs.RecordAudit("rollback", backupName, "applied")
	}
	return out, err
}

func (cs *ConfigStore) ValidateAndApply(apply bool) (string, error) {
	if cs.managedDir == "" {
		return "", errors.New("managed-dir not configured on gateway")
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()

	// Snapshot previous generated .cfg files for rollback if validation fails
	prev := make(map[string][]byte)
	existed := make(map[string]bool)
	for _, fn := range managedCfgFilenames {
		p := filepath.Join(cs.managedDir, fn)
		if data, err := os.ReadFile(p); err == nil {
			prev[fn] = data
			existed[fn] = true
		}
	}

	restorePrev := func() {
		for _, fn := range managedCfgFilenames {
			p := filepath.Join(cs.managedDir, fn)
			if existed[fn] {
				_ = os.WriteFile(p, prev[fn], 0o644)
			} else {
				_ = os.Remove(p)
			}
		}
	}

	rendered := cs.renderFilesLocked()
	for fn, content := range rendered {
		p := filepath.Join(cs.managedDir, fn)
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
			restorePrev()
			return "", err
		}
		if err := os.Rename(tmp, p); err != nil {
			restorePrev()
			return "", err
		}
	}

	// Run nagios -v pre-flight validation
	var valOut string
	if cs.nagiosBin != "" && cs.nagiosCfg != "" {
		cmd := exec.Command(cs.nagiosBin, "-v", cs.nagiosCfg)
		outBytes, err := cmd.CombinedOutput()
		valOut = string(outBytes)
		if err != nil {
			restorePrev()
			return valOut, fmt.Errorf("encore engine pre-flight validation failed: %w", err)
		}
	} else {
		valOut = "Validation skipped (encore-bin/encore-cfg not configured)"
	}

	if !apply {
		restorePrev()
		return valOut, nil
	}

	_ = cs.writeBackupLocked()
	_ = cs.saveJSONLocked()
	cs.committedCfg = cloneManagedConfig(cs.cfg)
	_ = cs.saveCommittedLocked()
	cs.pendingChanges = false

	// Trigger Nagios reload via external command pipe (no sudo required)
	if cs.cmdPipePath != "" {
		f, err := os.OpenFile(cs.cmdPipePath, os.O_WRONLY, 0)
		if err != nil {
			return valOut, fmt.Errorf("config written, but failed to trigger reload on %s: %w", cs.cmdPipePath, err)
		}
		_, werr := fmt.Fprintf(f, "[%d] RESTART_PROGRAM\n", time.Now().Unix())
		_ = f.Close()
		if werr != nil {
			return valOut, fmt.Errorf("config written, but reload write failed: %w", werr)
		}
	}

	cs.RecordAudit("apply_config", "nagios", "validated and reloaded")
	return valOut, nil
}
