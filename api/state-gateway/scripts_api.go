package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var validScriptName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

type CustomScriptInfo struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	ModTime   string `json:"mod_time"`
}

func (cs *ConfigStore) scriptsDir() (string, error) {
	if cs.managedDir == "" {
		return "", errors.New("managed-dir not configured")
	}
	dir := filepath.Join(cs.managedDir, "scripts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func registerScriptRoutes(mux *http.ServeMux, cs *ConfigStore) {
	mux.HandleFunc("/api/v1/scripts", func(w http.ResponseWriter, r *http.Request) {
		dir, err := cs.scriptsDir()
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "scripts": []CustomScriptInfo{}})
			return
		}
		switch r.Method {
		case http.MethodGet:
			entries, _ := os.ReadDir(dir)
			out := make([]CustomScriptInfo, 0, len(entries))
			for _, e := range entries {
				if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
					continue
				}
				info, err := e.Info()
				if err != nil {
					continue
				}
				out = append(out, CustomScriptInfo{
					Name:      e.Name(),
					Path:      filepath.Join(dir, e.Name()),
					SizeBytes: info.Size(),
					ModTime:   info.ModTime().UTC().Format(time.RFC3339),
				})
			}
			sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
			writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "dir": dir, "scripts": out})

		case http.MethodPost, http.MethodPut:
			var req struct {
				Name    string `json:"name"`
				Content string `json:"content"`
			}
			if err := decodeJSONBody(r, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if !validScriptName.MatchString(req.Name) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid script name (use letters, digits, ., _, -)"})
				return
			}
			content := strings.ReplaceAll(req.Content, "\r\n", "\n")
			dst := filepath.Join(dir, req.Name)
			tmp := dst + ".tmp"
			if err := os.WriteFile(tmp, []byte(content), 0o755); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			if err := os.Chmod(tmp, 0o755); err != nil {
				_ = os.Remove(tmp)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			if err := os.Rename(tmp, dst); err != nil {
				_ = os.Remove(tmp)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			cs.RecordAudit("save_script", req.Name, dst)
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "name": req.Name, "path": dst})

		case http.MethodDelete:
			name := r.URL.Query().Get("name")
			if !validScriptName.MatchString(name) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid script name"})
				return
			}
			if err := os.Remove(filepath.Join(dir, name)); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			cs.RecordAudit("delete_script", name, "")
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})

		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/scripts/content", func(w http.ResponseWriter, r *http.Request) {
		dir, err := cs.scriptsDir()
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		name := r.URL.Query().Get("name")
		if !validScriptName.MatchString(name) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid script name"})
			return
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"name": name, "path": filepath.Join(dir, name), "content": string(raw)})
	})

	mux.HandleFunc("/api/v1/scripts/test", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		dir, err := cs.scriptsDir()
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		var req struct {
			Name string `json:"name"`
			Args string `json:"args"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if !validScriptName.MatchString(req.Name) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid script name"})
			return
		}
		scriptPath := filepath.Join(dir, req.Name)
		if _, err := os.Stat(scriptPath); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "script not found"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		argFields := strings.Fields(req.Args)
		cmd := exec.CommandContext(ctx, scriptPath, argFields...)
		var outBuf, errBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &errBuf
		t0 := time.Now()
		runErr := cmd.Run()
		durMs := time.Since(t0).Milliseconds()

		exitCode := 0
		if runErr != nil {
			var ee *exec.ExitError
			if errors.As(runErr, &ee) {
				exitCode = ee.ExitCode()
			} else {
				exitCode = 3
				errBuf.WriteString("\n" + runErr.Error())
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"exit_code":   exitCode,
			"stdout":      outBuf.String(),
			"stderr":      errBuf.String(),
			"duration_ms": durMs,
		})
	})
}
