package main

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var validSecretKey = regexp.MustCompile(`^\$USER([2-9]|[12][0-9]|3[0-2])\$$`)
var anyUserMacro = regexp.MustCompile(`^\$USER([1-9]|[12][0-9]|3[0-2])\$$`)

type ResourceMacro struct {
	Key      string `json:"key"`
	Masked   string `json:"masked"`
	ReadOnly bool   `json:"read_only"`
	Hint     string `json:"hint,omitempty"`
}

func maskSecret(v string) string {
	if len(v) <= 4 {
		return "••••"
	}
	return "••••••" + v[len(v)-4:]
}

func readResourceMacros(path string) ([]ResourceMacro, []string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var lines []string
	var macros []ResourceMacro
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	for sc.Scan() {
		line := sc.Text()
		lines = append(lines, line)
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if k, v, ok := strings.Cut(trimmed, "="); ok {
			k = strings.TrimSpace(k)
			v = strings.TrimSpace(v)
			if anyUserMacro.MatchString(k) {
				ro := k == "$USER1$"
				masked := maskSecret(v)
				hint := ""
				if ro {
					masked = v
					hint = "Plugin directory ($USER1$ — read-only)"
				} else if k == "$USER2$" {
					hint = "Recommended for NCPA token"
				}
				macros = append(macros, ResourceMacro{
					Key:      k,
					Masked:   masked,
					ReadOnly: ro,
					Hint:     hint,
				})
			}
		}
	}
	sort.Slice(macros, func(i, j int) bool {
		ni, _ := strconv.Atoi(strings.Trim(macros[i].Key, "$USER"))
		nj, _ := strconv.Atoi(strings.Trim(macros[j].Key, "$USER"))
		return ni < nj
	})
	return macros, lines, nil
}

func upsertResourceMacro(path, backupDir, key, val string) error {
	_, lines, err := readResourceMacros(path)
	if err != nil {
		return err
	}
	if backupDir != "" {
		raw, _ := os.ReadFile(path)
		_ = os.WriteFile(filepath.Join(backupDir, fmt.Sprintf("resource.cfg.%s.bak", time.Now().UTC().Format("20060102-150405"))), raw, 0o640)
	}

	updated := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, key+"=") || strings.HasPrefix(trimmed, key+" =") {
			lines[i] = key + "=" + val
			updated = true
			break
		}
	}
	if !updated {
		lines = append(lines, key+"="+val)
	}
	out := strings.Join(lines, "\n") + "\n"
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(out), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func deleteResourceMacro(path, backupDir, key string) error {
	_, lines, err := readResourceMacros(path)
	if err != nil {
		return err
	}
	if backupDir != "" {
		raw, _ := os.ReadFile(path)
		_ = os.WriteFile(filepath.Join(backupDir, fmt.Sprintf("resource.cfg.%s.bak", time.Now().UTC().Format("20060102-150405"))), raw, 0o640)
	}
	next := make([]string, 0, len(lines))
	removed := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, key+"=") || strings.HasPrefix(trimmed, key+" =") {
			removed = true
			continue
		}
		next = append(next, line)
	}
	if !removed {
		return fmt.Errorf("macro %s not found", key)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(next, "\n")+"\n"), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func registerSecretRoutes(mux *http.ServeMux, cs *ConfigStore, resourceCfgPath, cmdPipePath string) {
	mux.HandleFunc("/api/v1/secrets", func(w http.ResponseWriter, r *http.Request) {
		if resourceCfgPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "secrets": []ResourceMacro{}})
			return
		}
		backupDir := ""
		if cs.managedDir != "" {
			backupDir = filepath.Join(cs.managedDir, "backups")
		}

		switch r.Method {
		case http.MethodGet:
			macros, _, err := readResourceMacros(resourceCfgPath)
			if err != nil {
				writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "path": resourceCfgPath, "error": err.Error(), "secrets": []ResourceMacro{}})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "path": resourceCfgPath, "secrets": macros})

		case http.MethodPost, http.MethodPut:
			var req struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			if err := decodeJSONBody(r, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			req.Key = strings.TrimSpace(req.Key)
			if !validSecretKey.MatchString(req.Key) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key must be $USER2$ through $USER32$ ($USER1$ is read-only)"})
				return
			}
			if strings.TrimSpace(req.Value) == "" || strings.ContainsAny(req.Value, "\r\n\x00") {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid secret value"})
				return
			}
			if err := upsertResourceMacro(resourceCfgPath, backupDir, req.Key, req.Value); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			if cmdPipePath != "" {
				if f, err := os.OpenFile(cmdPipePath, os.O_WRONLY, 0); err == nil {
					_, _ = fmt.Fprintf(f, "[%d] RESTART_PROGRAM\n", time.Now().Unix())
					_ = f.Close()
				}
			}
			cs.RecordAudit("set_secret", req.Key, "updated in resource.cfg & reloaded")
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "key": req.Key})

		case http.MethodDelete:
			key := strings.TrimSpace(r.URL.Query().Get("key"))
			if !validSecretKey.MatchString(key) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only $USER2$..$USER32$ can be deleted"})
				return
			}
			if err := deleteResourceMacro(resourceCfgPath, backupDir, key); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			if cmdPipePath != "" {
				if f, err := os.OpenFile(cmdPipePath, os.O_WRONLY, 0); err == nil {
					_, _ = fmt.Fprintf(f, "[%d] RESTART_PROGRAM\n", time.Now().Unix())
					_ = f.Close()
				}
			}
			cs.RecordAudit("delete_secret", key, "removed from resource.cfg & reloaded")
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted", "key": key})

		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})
}
