package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type LocalhostStatus struct {
	Configured bool             `json:"configured"`
	Path       string           `json:"path"`
	Exists     bool             `json:"exists"`
	Adopted    bool             `json:"adopted"`
	Raw        string           `json:"raw"`
	Hosts      []ManagedHost    `json:"parsed_hosts"`
	Services   []ManagedService `json:"parsed_services"`
	Hostgroups []ManagedHostgroup `json:"parsed_hostgroups"`
}

func stripNagiosComment(line string) string {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
		return ""
	}
	if idx := strings.IndexByte(line, ';'); idx >= 0 {
		line = strings.TrimSpace(line[:idx])
	}
	return line
}

// ParseNagiosObjectFile extracts host, hostgroup, and service blocks from a Nagios .cfg file.
func ParseNagiosObjectFile(raw string) ([]ManagedHost, []ManagedService, []ManagedHostgroup) {
	var hosts []ManagedHost
	var svcs []ManagedService
	var hgs []ManagedHostgroup

	scanner := bufio.NewScanner(strings.NewReader(raw))
	var blockType string
	fields := make(map[string]string)

	flushBlock := func() {
		if blockType == "" {
			return
		}
		switch blockType {
		case "host":
			if name := fields["host_name"]; name != "" {
				h := ManagedHost{
					Name:             name,
					Alias:            fields["alias"],
					Address:          fields["address"],
					CheckCommand:     fields["check_command"],
					CheckInterval:    5,
					RetryInterval:    1,
					MaxCheckAttempts: 3,
					CheckPeriod:      fields["check_period"],
					Contacts:         fields["contacts"],
					Enabled:          true,
				}
				if h.Alias == "" {
					h.Alias = h.Name
				}
				if h.CheckCommand == "" {
					h.CheckCommand = "check-host-alive"
				}
				if h.CheckPeriod == "" {
					h.CheckPeriod = "24x7"
				}
				if v, err := strconv.Atoi(fields["check_interval"]); err == nil && v > 0 {
					h.CheckInterval = v
				}
				if v, err := strconv.Atoi(fields["retry_interval"]); err == nil && v > 0 {
					h.RetryInterval = v
				}
				if v, err := strconv.Atoi(fields["max_check_attempts"]); err == nil && v > 0 {
					h.MaxCheckAttempts = v
				}
				if hgsStr := fields["hostgroups"]; hgsStr != "" {
					for _, g := range strings.Split(hgsStr, ",") {
						if s := strings.TrimSpace(g); s != "" {
							h.Hostgroups = append(h.Hostgroups, s)
						}
					}
				}
				hosts = append(hosts, h)
			}
		case "service":
			if hn, sd := fields["host_name"], fields["service_description"]; hn != "" && sd != "" {
				s := ManagedService{
					HostName:           hn,
					ServiceDescription: sd,
					CheckCommand:       fields["check_command"],
					CheckInterval:      5,
					RetryInterval:      1,
					MaxCheckAttempts:   3,
					CheckPeriod:        fields["check_period"],
					Contacts:           fields["contacts"],
					Enabled:            true,
				}
				if s.CheckPeriod == "" {
					s.CheckPeriod = "24x7"
				}
				if v, err := strconv.Atoi(fields["check_interval"]); err == nil && v > 0 {
					s.CheckInterval = v
				}
				if v, err := strconv.Atoi(fields["retry_interval"]); err == nil && v > 0 {
					s.RetryInterval = v
				}
				if v, err := strconv.Atoi(fields["max_check_attempts"]); err == nil && v > 0 {
					s.MaxCheckAttempts = v
				}
				if sgsStr := fields["servicegroups"]; sgsStr != "" {
					for _, g := range strings.Split(sgsStr, ",") {
						if x := strings.TrimSpace(g); x != "" {
							s.Servicegroups = append(s.Servicegroups, x)
						}
					}
				}
				svcs = append(svcs, s)
			}
		case "hostgroup":
			if gn := fields["hostgroup_name"]; gn != "" {
				g := ManagedHostgroup{
					GroupName: gn,
					Alias:     fields["alias"],
				}
				if g.Alias == "" {
					g.Alias = gn
				}
				if ms := fields["members"]; ms != "" {
					for _, m := range strings.Split(ms, ",") {
						if x := strings.TrimSpace(m); x != "" {
							g.Members = append(g.Members, x)
						}
					}
				}
				hgs = append(hgs, g)
			}
		}
		blockType = ""
		fields = make(map[string]string)
	}

	for scanner.Scan() {
		line := stripNagiosComment(scanner.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "define ") && strings.HasSuffix(line, "{") {
			flushBlock()
			parts := strings.Fields(strings.TrimSuffix(line, "{"))
			if len(parts) >= 2 {
				blockType = parts[1]
			}
			continue
		}
		if line == "}" {
			flushBlock()
			continue
		}
		if blockType != "" {
			idx := strings.IndexAny(line, " \t")
			if idx > 0 {
				k := strings.TrimSpace(line[:idx])
				v := strings.TrimSpace(line[idx+1:])
				if k != "" && v != "" {
					fields[k] = v
				}
			}
		}
	}
	flushBlock()
	return hosts, svcs, hgs
}

func (cs *ConfigStore) GetLocalhostStatus(localhostPath string) LocalhostStatus {
	st := LocalhostStatus{
		Configured: localhostPath != "",
		Path:       localhostPath,
		Hosts:      []ManagedHost{},
		Services:   []ManagedService{},
		Hostgroups: []ManagedHostgroup{},
	}
	if localhostPath == "" {
		return st
	}
	rawBytes, err := os.ReadFile(localhostPath)
	if err != nil {
		return st
	}
	st.Exists = true
	st.Raw = string(rawBytes)
	st.Hosts, st.Services, st.Hostgroups = ParseNagiosObjectFile(st.Raw)
	if strings.Contains(st.Raw, "ADOPTED BY ENCORE DASHBOARD") || (len(st.Hosts) == 0 && len(st.Services) == 0) {
		cs.mu.Lock()
		for _, h := range cs.cfg.Hosts {
			if h.Name == "localhost" {
				st.Adopted = true
				break
			}
		}
		cs.mu.Unlock()
	}
	return st
}

// AdoptLocalhost imports localhost.cfg objects into encore-managed.json, backs up the original file,
// replaces localhost.cfg with a clean comment placeholder to avoid duplicate definitions, and applies.
func (cs *ConfigStore) AdoptLocalhost(localhostPath string) (string, int, int, error) {
	if cs.managedDir == "" {
		return "", 0, 0, errors.New("managed-dir is not configured")
	}
	if localhostPath == "" {
		return "", 0, 0, errors.New("localhost-cfg path is not configured")
	}
	rawBytes, err := os.ReadFile(localhostPath)
	if err != nil {
		return "", 0, 0, fmt.Errorf("read %s: %w", localhostPath, err)
	}
	hosts, svcs, hgs := ParseNagiosObjectFile(string(rawBytes))
	if len(hosts) == 0 && len(svcs) == 0 {
		return "", 0, 0, errors.New("no host or service definitions found in localhost.cfg (already adopted?)")
	}

	// Backup original localhost.cfg
	backupOrig := filepath.Join(cs.managedDir, "backups", fmt.Sprintf("localhost.cfg.%s.orig", time.Now().UTC().Format("20060102-150405")))
	if err := os.WriteFile(backupOrig, rawBytes, 0o644); err != nil {
		return "", 0, 0, fmt.Errorf("backup localhost.cfg: %w", err)
	}

	// Merge into ManagedConfig
	for _, g := range hgs {
		_ = cs.UpsertHostgroup(g)
	}
	for _, h := range hosts {
		_ = cs.UpsertHost(h)
	}
	for _, s := range svcs {
		_ = cs.UpsertService(s)
	}

	// Replace localhost.cfg with placeholder so nagios -v has no duplicate definitions
	placeholder := fmt.Sprintf("# ADOPTED BY ENCORE DASHBOARD on %s\n# Original backed up to %s\n# Manage localhost and its services directly in Encore Dashboard -> Manage.\n",
		time.Now().UTC().Format(time.RFC3339), backupOrig)
	if err := os.WriteFile(localhostPath, []byte(placeholder), 0o644); err != nil {
		return "", 0, 0, fmt.Errorf("write placeholder to %s (check permissions for nagios user): %w", localhostPath, err)
	}

	out, err := cs.ValidateAndApply(true)
	if err != nil {
		// Restore original localhost.cfg if validation failed!
		_ = os.WriteFile(localhostPath, rawBytes, 0o644)
		return out, 0, 0, err
	}
	cs.RecordAudit("adopt_localhost", localhostPath, fmt.Sprintf("hosts=%d services=%d", len(hosts), len(svcs)))
	return out, len(hosts), len(svcs), nil
}

// SaveLocalhostRaw safely validates and saves direct edits to localhost.cfg.
func (cs *ConfigStore) SaveLocalhostRaw(localhostPath, newContent string) (string, error) {
	if localhostPath == "" {
		return "", errors.New("localhost-cfg path is not configured")
	}
	prevBytes, err := os.ReadFile(localhostPath)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", localhostPath, err)
	}

	if cs.managedDir != "" {
		bpath := filepath.Join(cs.managedDir, "backups", fmt.Sprintf("localhost.cfg.%s.bak", time.Now().UTC().Format("20060102-150405")))
		_ = os.WriteFile(bpath, prevBytes, 0o644)
	}

	if err := os.WriteFile(localhostPath, []byte(newContent), 0o644); err != nil {
		return "", fmt.Errorf("write %s: %w", localhostPath, err)
	}

	var valOut string
	if cs.nagiosBin != "" && cs.nagiosCfg != "" {
		cmd := exec.Command(cs.nagiosBin, "-v", cs.nagiosCfg)
		outBytes, err := cmd.CombinedOutput()
		valOut = string(outBytes)
		if err != nil {
			_ = os.WriteFile(localhostPath, prevBytes, 0o644)
			return valOut, fmt.Errorf("nagios pre-flight validation failed: %w", err)
		}
	}

	if cs.cmdPipePath != "" {
		if f, err := os.OpenFile(cs.cmdPipePath, os.O_WRONLY, 0); err == nil {
			_, _ = fmt.Fprintf(f, "[%d] RESTART_PROGRAM\n", time.Now().Unix())
			_ = f.Close()
		}
	}
	cs.RecordAudit("edit_localhost_raw", localhostPath, "validated and reloaded")
	return valOut, nil
}
