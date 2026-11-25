package main

import (
	"bufio"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type LegacyImportParsed struct {
	Hosts         []ManagedHost         `json:"hosts"`
	Services      []ManagedService      `json:"services"`
	Commands      []ManagedCommand      `json:"commands"`
	Contacts      []ManagedContact      `json:"contacts"`
	Hostgroups    []ManagedHostgroup    `json:"hostgroups"`
	Servicegroups []ManagedServicegroup `json:"servicegroups"`
	SkippedBlocks int                   `json:"skipped_blocks"`
}

type LegacyImportResult struct {
	DryRun        bool     `json:"dry_run"`
	HostsNew      int      `json:"hosts_new"`
	HostsUpdated  int      `json:"hosts_updated"`
	HostsSkipped  int      `json:"hosts_skipped"`
	SvcsNew       int      `json:"services_new"`
	SvcsUpdated   int      `json:"services_updated"`
	SvcsSkipped   int      `json:"services_skipped"`
	CmdsNew       int      `json:"commands_new"`
	GroupsNew     int      `json:"groups_new"`
	ContactsNew   int      `json:"contacts_new"`
	SkippedBlocks int      `json:"skipped_blocks"`
	PreviewItems  []string `json:"preview_items"`
}

func parseLegacyNagiosCfg(raw string) LegacyImportParsed {
	res := LegacyImportParsed{
		Hosts:         []ManagedHost{},
		Services:      []ManagedService{},
		Commands:      []ManagedCommand{},
		Contacts:      []ManagedContact{},
		Hostgroups:    []ManagedHostgroup{},
		Servicegroups: []ManagedServicegroup{},
	}

	type rawService struct {
		hosts      []string
		hostgroups []string
		desc       string
		cmd        string
		interval   int
		retry      int
		attempts   int
		period     string
		contacts   string
		svcGroups  []string
	}
	var rawSvcs []rawService
	hgMembers := make(map[string]map[string]bool)
	addHGMember := func(hg, host string) {
		if hg == "" || host == "" {
			return
		}
		if hgMembers[hg] == nil {
			hgMembers[hg] = make(map[string]bool)
		}
		hgMembers[hg][host] = true
	}

	splitCSV := func(s string) []string {
		var out []string
		for _, p := range strings.Split(s, ",") {
			p = strings.TrimSpace(p)
			if p != "" && !strings.HasPrefix(p, "!") {
				out = append(out, p)
			}
		}
		return out
	}
	parseIntDef := func(s string, def int) int {
		if v, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && v > 0 {
			return v
		}
		return def
	}

	var blockType string
	fields := make(map[string]string)

	flush := func() {
		if blockType == "" {
			return
		}
		defer func() {
			blockType = ""
			fields = make(map[string]string)
		}()
		// Skip abstract templates (register 0)
		if strings.TrimSpace(fields["register"]) == "0" {
			res.SkippedBlocks++
			return
		}
		switch blockType {
		case "host":
			name := strings.TrimSpace(fields["host_name"])
			addr := strings.TrimSpace(fields["address"])
			if name == "" {
				res.SkippedBlocks++
				return
			}
			if addr == "" {
				addr = name
			}
			alias := strings.TrimSpace(fields["alias"])
			if alias == "" {
				alias = name
			}
			cmd := strings.TrimSpace(fields["check_command"])
			if cmd == "" {
				cmd = "check-host-alive"
			}
			hgs := splitCSV(fields["hostgroups"])
			for _, g := range hgs {
				addHGMember(g, name)
			}
			res.Hosts = append(res.Hosts, ManagedHost{
				Name:             name,
				Alias:            alias,
				Address:          addr,
				CheckCommand:     cmd,
				CheckInterval:    parseIntDef(fields["check_interval"], 5),
				RetryInterval:    parseIntDef(fields["retry_interval"], 1),
				MaxCheckAttempts: parseIntDef(fields["max_check_attempts"], 3),
				CheckPeriod:      firstNonEmpty(fields["check_period"], "24x7"),
				Contacts:         strings.TrimSpace(fields["contacts"]),
				Hostgroups:       hgs,
				Enabled:          true,
			})
		case "service":
			desc := strings.TrimSpace(fields["service_description"])
			cmd := strings.TrimSpace(fields["check_command"])
			if desc == "" || cmd == "" {
				res.SkippedBlocks++
				return
			}
			rawSvcs = append(rawSvcs, rawService{
				hosts:      splitCSV(fields["host_name"]),
				hostgroups: splitCSV(fields["hostgroup_name"]),
				desc:       desc,
				cmd:        cmd,
				interval:   parseIntDef(fields["check_interval"], 5),
				retry:      parseIntDef(fields["retry_interval"], 1),
				attempts:   parseIntDef(fields["max_check_attempts"], 3),
				period:     firstNonEmpty(fields["check_period"], "24x7"),
				contacts:   strings.TrimSpace(fields["contacts"]),
				svcGroups:  splitCSV(fields["servicegroups"]),
			})
		case "command":
			name := strings.TrimSpace(fields["command_name"])
			line := strings.TrimSpace(fields["command_line"])
			if name == "" || line == "" {
				res.SkippedBlocks++
				return
			}
			res.Commands = append(res.Commands, ManagedCommand{CommandName: name, CommandLine: line})
		case "contact":
			name := strings.TrimSpace(fields["contact_name"])
			if name == "" {
				res.SkippedBlocks++
				return
			}
			res.Contacts = append(res.Contacts, ManagedContact{
				ContactName: name,
				Alias:       firstNonEmpty(fields["alias"], name),
				Email:       strings.TrimSpace(fields["email"]),
			})
		case "hostgroup":
			name := strings.TrimSpace(fields["hostgroup_name"])
			if name == "" {
				res.SkippedBlocks++
				return
			}
			members := splitCSV(fields["members"])
			for _, m := range members {
				addHGMember(name, m)
			}
			res.Hostgroups = append(res.Hostgroups, ManagedHostgroup{
				GroupName: name,
				Alias:     firstNonEmpty(fields["alias"], name),
				Members:   members,
			})
		case "servicegroup":
			name := strings.TrimSpace(fields["servicegroup_name"])
			if name == "" {
				res.SkippedBlocks++
				return
			}
			res.Servicegroups = append(res.Servicegroups, ManagedServicegroup{
				GroupName: name,
				Alias:     firstNonEmpty(fields["alias"], name),
			})
		}
	}

	sc := bufio.NewScanner(strings.NewReader(raw))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := stripNagiosComment(sc.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "define ") && strings.Contains(line, "{") {
			flush()
			hdr := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line), "{"))
			parts := strings.Fields(hdr)
			if len(parts) >= 2 {
				blockType = strings.ToLower(parts[1])
			}
			continue
		}
		if line == "}" {
			flush()
			continue
		}
		if blockType != "" {
			idx := strings.IndexAny(line, " \t")
			if idx > 0 {
				k := strings.ToLower(strings.TrimSpace(line[:idx]))
				v := strings.TrimSpace(line[idx+1:])
				if k != "" && v != "" {
					fields[k] = v
				}
			}
		}
	}
	flush()

	// Expand raw services across comma-separated host_name & hostgroup_name
	for _, rs := range rawSvcs {
		targets := make(map[string]bool)
		for _, h := range rs.hosts {
			targets[h] = true
		}
		for _, hg := range rs.hostgroups {
			for h := range hgMembers[hg] {
				targets[h] = true
			}
		}
		names := make([]string, 0, len(targets))
		for h := range targets {
			names = append(names, h)
		}
		sort.Strings(names)
		for _, hn := range names {
			res.Services = append(res.Services, ManagedService{
				HostName:           hn,
				ServiceDescription: rs.desc,
				CheckCommand:       rs.cmd,
				CheckInterval:      rs.interval,
				RetryInterval:      rs.retry,
				MaxCheckAttempts:   rs.attempts,
				CheckPeriod:        rs.period,
				Contacts:           rs.contacts,
				Servicegroups:      append([]string(nil), rs.svcGroups...),
				Enabled:            true,
			})
		}
	}

	return res
}

func firstNonEmpty(a, b string) string {
	a = strings.TrimSpace(a)
	if a != "" {
		return a
	}
	return b
}

func (cs *ConfigStore) ImportLegacyNagios(raw string, overwrite, dryRun bool, actor string) (LegacyImportResult, error) {
	if strings.TrimSpace(raw) == "" {
		return LegacyImportResult{}, errors.New("empty nagios .cfg input")
	}
	parsed := parseLegacyNagiosCfg(raw)
	res := LegacyImportResult{
		DryRun:        dryRun,
		SkippedBlocks: parsed.SkippedBlocks,
		PreviewItems:  []string{},
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	hostIdx := make(map[string]int, len(cs.cfg.Hosts))
	for i, h := range cs.cfg.Hosts {
		hostIdx[h.Name] = i
	}
	svcIdx := make(map[string]int, len(cs.cfg.Services))
	for i, s := range cs.cfg.Services {
		svcIdx[s.HostName+"\x00"+s.ServiceDescription] = i
	}
	cmdIdx := make(map[string]int, len(cs.cfg.Commands))
	for i, c := range cs.cfg.Commands {
		cmdIdx[c.CommandName] = i
	}
	hgIdx := make(map[string]int, len(cs.cfg.Hostgroups))
	for i, g := range cs.cfg.Hostgroups {
		hgIdx[g.GroupName] = i
	}
	sgIdx := make(map[string]int, len(cs.cfg.Servicegroups))
	for i, g := range cs.cfg.Servicegroups {
		sgIdx[g.GroupName] = i
	}
	ctIdx := make(map[string]int, len(cs.cfg.Contacts))
	for i, c := range cs.cfg.Contacts {
		ctIdx[c.ContactName] = i
	}

	addPreview := func(s string) {
		if len(res.PreviewItems) < 40 {
			res.PreviewItems = append(res.PreviewItems, s)
		}
	}

	for _, h := range parsed.Hosts {
		if idx, ok := hostIdx[h.Name]; ok {
			if overwrite {
				res.HostsUpdated++
				addPreview("UPDATE host: " + h.Name)
				if !dryRun {
					cs.cfg.Hosts[idx] = h
				}
			} else {
				res.HostsSkipped++
			}
		} else {
			res.HostsNew++
			addPreview("NEW host: " + h.Name + " (" + h.Address + ")")
			if !dryRun {
				hostIdx[h.Name] = len(cs.cfg.Hosts)
				cs.cfg.Hosts = append(cs.cfg.Hosts, h)
			}
		}
	}

	for _, s := range parsed.Services {
		k := s.HostName + "\x00" + s.ServiceDescription
		if idx, ok := svcIdx[k]; ok {
			if overwrite {
				res.SvcsUpdated++
				addPreview("UPDATE svc: " + s.HostName + " / " + s.ServiceDescription)
				if !dryRun {
					cs.cfg.Services[idx] = s
				}
			} else {
				res.SvcsSkipped++
			}
		} else {
			res.SvcsNew++
			addPreview("NEW svc: " + s.HostName + " / " + s.ServiceDescription)
			if !dryRun {
				svcIdx[k] = len(cs.cfg.Services)
				cs.cfg.Services = append(cs.cfg.Services, s)
			}
		}
	}

	for _, c := range parsed.Commands {
		if idx, ok := cmdIdx[c.CommandName]; ok {
			if overwrite && !dryRun {
				cs.cfg.Commands[idx] = c
			}
		} else {
			res.CmdsNew++
			addPreview("NEW command: " + c.CommandName)
			if !dryRun {
				cmdIdx[c.CommandName] = len(cs.cfg.Commands)
				cs.cfg.Commands = append(cs.cfg.Commands, c)
			}
		}
	}

	for _, g := range parsed.Hostgroups {
		if _, ok := hgIdx[g.GroupName]; !ok {
			res.GroupsNew++
			addPreview("NEW hostgroup: " + g.GroupName)
			if !dryRun {
				hgIdx[g.GroupName] = len(cs.cfg.Hostgroups)
				cs.cfg.Hostgroups = append(cs.cfg.Hostgroups, g)
			}
		}
	}
	for _, g := range parsed.Servicegroups {
		if _, ok := sgIdx[g.GroupName]; !ok {
			res.GroupsNew++
			addPreview("NEW servicegroup: " + g.GroupName)
			if !dryRun {
				sgIdx[g.GroupName] = len(cs.cfg.Servicegroups)
				cs.cfg.Servicegroups = append(cs.cfg.Servicegroups, g)
			}
		}
	}
	for _, c := range parsed.Contacts {
		if _, ok := ctIdx[c.ContactName]; !ok {
			res.ContactsNew++
			addPreview("NEW contact: " + c.ContactName)
			if !dryRun {
				ctIdx[c.ContactName] = len(cs.cfg.Contacts)
				cs.cfg.Contacts = append(cs.cfg.Contacts, c)
			}
		}
	}

	if !dryRun && (res.HostsNew+res.HostsUpdated+res.SvcsNew+res.SvcsUpdated+res.CmdsNew+res.GroupsNew+res.ContactsNew > 0) {
		cs.pendingChanges = true
		if err := cs.saveJSONLocked(); err != nil {
			return res, err
		}
		cs.RecordAudit("import_legacy_cfg",
			fmt.Sprintf("+%d hosts, +%d svcs, +%d cmds", res.HostsNew, res.SvcsNew, res.CmdsNew),
			"by="+actor)
	}
	return res, nil
}

func registerLegacyImportRoutes(mux *http.ServeMux, cs *ConfigStore) {
	mux.HandleFunc("/api/v1/config/import/nagios", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			Content   string `json:"content"`
			Overwrite bool   `json:"overwrite"`
			DryRun    bool   `json:"dry_run"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if r.URL.Query().Get("dry_run") == "1" {
			req.DryRun = true
		}
		res, err := cs.ImportLegacyNagios(req.Content, req.Overwrite, req.DryRun, actorFromRequest(r))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
}
