package main

import (
	"bufio"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type CatalogCommand struct {
	CommandName string `json:"command_name"`
	CommandLine string `json:"command_line"`
	Source      string `json:"source"`
	FastPath    bool   `json:"fast_path"`
	Example     string `json:"example"`
	Description string `json:"description"`
}

type CatalogPlugin struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Directory  string `json:"directory"`
	IsCustom   bool   `json:"is_custom"`
	Executable bool   `json:"executable"`
}

var commandHints = map[string][2]string{
	"check-host-alive": {"check-host-alive", "Default host liveness check via ICMP ping"},
	"check_ping":       {"check_ping!100.0,20%!500.0,60%", "ICMP ping with warn/crit RTA & packet loss"},
	"check_http":       {"check_http!-p 80 -u /", "HTTP/HTTPS endpoint check (Go fast-path)"},
	"check_tcp":        {"check_tcp!443", "TCP port connectivity & latency check (Go fast-path)"},
	"check_ssh":        {"check_ssh", "SSH daemon banner & connectivity check"},
	"check_local_disk": {"check_local_disk!20%!10%!/", "Local filesystem free space check"},
	"check_local_load": {"check_local_load!5.0,4.0,3.0!10.0,6.0,4.0", "Local 1/5/15m CPU load average check"},
	"check_local_procs":{"check_local_procs!250!400!RSZDT", "Local running process count check"},
	"check_local_users":{"check_local_users!20!50", "Local logged-in user count check"},
	"check_local_swap": {"check_local_swap!20%!10%", "Local swap memory free percentage check"},
	"check_snmp":       {"check_snmp!-C public -o sysUpTime.0", "SNMP OID query check"},
	"check_ncpa":       {"check_ncpa!<TOKEN>!cpu/percent!-w 80 -c 90", "Remote Linux/Windows check via NCPA HTTPS API (Go fast-path)"},
}

func isGoFastPath(cmdLine string) bool {
	for _, tok := range []string{"check_tcp", "check_http", "check_dummy", "check_ncpa.py", "check_ncpa"} {
		if strings.Contains(cmdLine, tok) {
			return true
		}
	}
	return false
}

func parseCommandsCfg(path string) []ManagedCommand {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []ManagedCommand
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	inCmd := false
	var name, line string
	for sc.Scan() {
		s := stripNagiosComment(sc.Text())
		if s == "" {
			continue
		}
		if strings.HasPrefix(s, "define command") && strings.HasSuffix(s, "{") {
			inCmd = true
			name, line = "", ""
			continue
		}
		if s == "}" && inCmd {
			if name != "" && line != "" {
				out = append(out, ManagedCommand{CommandName: name, CommandLine: line})
			}
			inCmd = false
			continue
		}
		if inCmd {
			if idx := strings.IndexAny(s, " \t"); idx > 0 {
				k := strings.TrimSpace(s[:idx])
				v := strings.TrimSpace(s[idx+1:])
				if k == "command_name" {
					name = v
				} else if k == "command_line" {
					line = v
				}
			}
		}
	}
	return out
}

func parseUser1FromResource(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "/usr/local/nagios/libexec"
	}
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	for sc.Scan() {
		s := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(s, "$USER1$=") {
			return strings.TrimSpace(strings.TrimPrefix(s, "$USER1$="))
		}
	}
	return "/usr/local/nagios/libexec"
}

func scanPluginDirs(dirs []string, customDir string) []CatalogPlugin {
	seen := make(map[string]bool)
	var out []CatalogPlugin
	for _, d := range dirs {
		if d == "" || seen[d] {
			continue
		}
		seen[d] = true
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			out = append(out, CatalogPlugin{
				Name:       e.Name(),
				Path:       filepath.Join(d, e.Name()),
				Directory:  d,
				IsCustom:   d == customDir,
				Executable: info.Mode()&0o111 != 0,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsCustom != out[j].IsCustom {
			return out[i].IsCustom
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func registerCatalogRoutes(mux *http.ServeMux, cs *ConfigStore, commandsCfg, resourceCfg, localhostCfg, nagiosCfg string) {
	mux.HandleFunc("/api/v1/catalog/commands", func(w http.ResponseWriter, r *http.Request) {
		byName := make(map[string]CatalogCommand)
		for _, c := range parseCommandsCfg(commandsCfg) {
			hint := commandHints[c.CommandName]
			ex := hint[0]
			if ex == "" {
				ex = c.CommandName
			}
			byName[c.CommandName] = CatalogCommand{
				CommandName: c.CommandName,
				CommandLine: c.CommandLine,
				Source:      "built-in",
				FastPath:    isGoFastPath(c.CommandLine),
				Example:     ex,
				Description: hint[1],
			}
		}
		cfg, _, _ := cs.Snapshot()
		for _, c := range cfg.Commands {
			hint := commandHints[c.CommandName]
			ex := hint[0]
			if ex == "" {
				ex = c.CommandName
			}
			byName[c.CommandName] = CatalogCommand{
				CommandName: c.CommandName,
				CommandLine: c.CommandLine,
				Source:      "managed",
				FastPath:    isGoFastPath(c.CommandLine),
				Example:     ex,
				Description: hint[1],
			}
		}
		list := make([]CatalogCommand, 0, len(byName))
		for _, v := range byName {
			list = append(list, v)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].CommandName < list[j].CommandName })
		writeJSON(w, http.StatusOK, map[string]any{"commands": list})
	})

	mux.HandleFunc("/api/v1/catalog/plugins", func(w http.ResponseWriter, r *http.Request) {
		user1 := parseUser1FromResource(resourceCfg)
		scriptsDir := ""
		if cs.managedDir != "" {
			scriptsDir = filepath.Join(cs.managedDir, "scripts")
		}
		plugins := scanPluginDirs([]string{scriptsDir, user1, "/usr/local/nagios/libexec"}, scriptsDir)
		writeJSON(w, http.StatusOK, map[string]any{
			"user1_dir":   user1,
			"scripts_dir": scriptsDir,
			"plugins":     plugins,
		})
	})

	mux.HandleFunc("/api/v1/catalog/paths", func(w http.ResponseWriter, r *http.Request) {
		user1 := parseUser1FromResource(resourceCfg)
		scriptsDir := ""
		backupsDir := ""
		auditLog := ""
		if cs.managedDir != "" {
			scriptsDir = filepath.Join(cs.managedDir, "scripts")
			backupsDir = filepath.Join(cs.managedDir, "backups")
			auditLog = filepath.Join(cs.managedDir, "encore-audit.log")
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"nagios_cfg":    nagiosCfg,
			"managed_dir":   cs.managedDir,
			"scripts_dir":   scriptsDir,
			"backups_dir":   backupsDir,
			"audit_log":     auditLog,
			"commands_cfg":  commandsCfg,
			"resource_cfg":  resourceCfg,
			"localhost_cfg": localhostCfg,
			"plugins_dir":   user1,
		})
	})
}
