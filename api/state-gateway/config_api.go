package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func decodeJSONBody(r *http.Request, dst any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(dst)
}

func registerConfigRoutes(mux *http.ServeMux, cs *ConfigStore, localhostCfgPath string) {
	mux.HandleFunc("/api/v1/config/localhost", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, cs.GetLocalhostStatus(localhostCfgPath))
		case http.MethodPut, http.MethodPost:
			var req struct {
				Raw string `json:"raw"`
			}
			if err := decodeJSONBody(r, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			out, err := cs.SaveLocalhostRaw(localhostCfgPath, req.Raw)
			if err != nil {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"saved": false, "error": err.Error(), "output": out})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"saved": true, "output": out})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/localhost/adopt", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		out, nh, ns, err := cs.AdoptLocalhost(localhostCfgPath)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"adopted": false, "error": err.Error(), "output": out})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"adopted":  true,
			"hosts":    nh,
			"services": ns,
			"output":   out,
		})
	})

	mux.HandleFunc("/api/v1/config", func(w http.ResponseWriter, r *http.Request) {
		cfg, pending, enabled := cs.Snapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":         enabled,
			"pending_changes": pending,
			"config":          cfg,
			"diff":            cs.Diff(),
		})
	})

	mux.HandleFunc("/api/v1/config/hosts", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cfg, _, _ := cs.Snapshot()
			writeJSON(w, http.StatusOK, map[string]any{"hosts": cfg.Hosts})
		case http.MethodPost, http.MethodPut:
			var h ManagedHost
			if err := decodeJSONBody(r, &h); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := cs.UpsertHost(h); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "host": h.Name})
		case http.MethodDelete:
			name := r.URL.Query().Get("name")
			cascade := r.URL.Query().Get("cascade") != "0"
			if err := cs.DeleteHost(name, cascade); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted", "host": name})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/hosts/clone", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			SourceName      string `json:"source_name"`
			NewName         string `json:"new_name"`
			NewAlias        string `json:"new_alias"`
			NewAddress      string `json:"new_address"`
			IncludeServices bool   `json:"include_services"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		nSvc, err := cs.CloneHost(req.SourceName, req.NewName, req.NewAlias, req.NewAddress, req.IncludeServices)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "cloned",
			"new_name":        req.NewName,
			"cloned_services": nSvc,
		})
	})

	mux.HandleFunc("/api/v1/config/services", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cfg, _, _ := cs.Snapshot()
			writeJSON(w, http.StatusOK, map[string]any{"services": cfg.Services})
		case http.MethodPost, http.MethodPut:
			var s ManagedService
			if err := decodeJSONBody(r, &s); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := cs.UpsertService(s); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "service": s.HostName + "/" + s.ServiceDescription})
		case http.MethodDelete:
			host := r.URL.Query().Get("host")
			desc := r.URL.Query().Get("description")
			if err := cs.DeleteService(host, desc); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/services/clone", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			SourceHost        string `json:"source_host"`
			SourceDescription string `json:"source_description"`
			TargetHost        string `json:"target_host"`
			TargetDescription string `json:"target_description"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := cs.CloneService(req.SourceHost, req.SourceDescription, req.TargetHost, req.TargetDescription); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "cloned"})
	})

	mux.HandleFunc("/api/v1/config/commands", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cfg, _, _ := cs.Snapshot()
			writeJSON(w, http.StatusOK, map[string]any{"commands": cfg.Commands})
		case http.MethodPost, http.MethodPut:
			var c ManagedCommand
			if err := decodeJSONBody(r, &c); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := cs.UpsertCommand(c); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved"})
		case http.MethodDelete:
			name := r.URL.Query().Get("name")
			if err := cs.DeleteCommand(name); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/contacts", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cfg, _, _ := cs.Snapshot()
			writeJSON(w, http.StatusOK, map[string]any{"contacts": cfg.Contacts})
		case http.MethodPost, http.MethodPut:
			var c ManagedContact
			if err := decodeJSONBody(r, &c); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := cs.UpsertContact(c); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved"})
		case http.MethodDelete:
			name := r.URL.Query().Get("name")
			if err := cs.DeleteContact(name); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/hostgroups", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cfg, _, _ := cs.Snapshot()
			writeJSON(w, http.StatusOK, map[string]any{"hostgroups": cfg.Hostgroups})
		case http.MethodPost, http.MethodPut:
			var g ManagedHostgroup
			if err := decodeJSONBody(r, &g); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := cs.UpsertHostgroup(g); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved"})
		case http.MethodDelete:
			name := r.URL.Query().Get("name")
			if err := cs.DeleteHostgroup(name); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/servicegroups", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cfg, _, _ := cs.Snapshot()
			writeJSON(w, http.StatusOK, map[string]any{"servicegroups": cfg.Servicegroups})
		case http.MethodPost, http.MethodPut:
			var g ManagedServicegroup
			if err := decodeJSONBody(r, &g); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := cs.UpsertServicegroup(g); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved"})
		case http.MethodDelete:
			name := r.URL.Query().Get("name")
			if err := cs.DeleteServicegroup(name); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/hosts/bulk", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			Action string   `json:"action"` // enable, disable, delete
			Hosts  []string `json:"hosts"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		n, err := cs.BulkHostsAction(req.Action, req.Hosts)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "affected": n})
	})

	mux.HandleFunc("/api/v1/config/services/bulk", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			Action   string       `json:"action"` // enable, disable, delete
			Services []ServiceRef `json:"services"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		n, err := cs.BulkServicesAction(req.Action, req.Services)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "affected": n})
	})

	mux.HandleFunc("/api/v1/config/diff", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, cs.Diff())
	})

	mux.HandleFunc("/api/v1/config/discard", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		n, err := cs.DiscardPending()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "discarded", "reverted": n})
	})

	mux.HandleFunc("/api/v1/config/templates", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cfg, _, _ := cs.Snapshot()
			writeJSON(w, http.StatusOK, map[string]any{"templates": cfg.Templates})
		case http.MethodPost, http.MethodPut:
			var t ServiceTemplate
			if err := decodeJSONBody(r, &t); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := cs.UpsertTemplate(t); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "name": t.Name})
		case http.MethodDelete:
			name := r.URL.Query().Get("name")
			if err := cs.DeleteTemplate(name); err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	mux.HandleFunc("/api/v1/config/templates/from-host", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			HostName    string `json:"host_name"`
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		cnt, err := cs.SaveTemplateFromHost(req.HostName, req.Name, req.Description)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "services": cnt})
	})

	mux.HandleFunc("/api/v1/config/templates/apply", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			Template  string   `json:"template"`
			Hosts     []string `json:"hosts"`
			Overwrite bool     `json:"overwrite"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		added, skipped, err := cs.ApplyTemplate(req.Template, req.Hosts, req.Overwrite)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "applied", "added": added, "skipped": skipped})
	})

	mux.HandleFunc("/api/v1/config/backups/download", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		if name == "" || name == "current" {
			cfg, _, _ := cs.Snapshot()
			raw, _ := json.MarshalIndent(cfg, "", "  ")
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Disposition", `attachment; filename="encore-config-current.json"`)
			_, _ = w.Write(raw)
			return
		}
		if strings.ContainsAny(name, "/\\") || !strings.HasSuffix(name, ".json") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid backup name"})
			return
		}
		raw, err := os.ReadFile(filepath.Join(cs.managedDir, "backups", name))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "backup not found"})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
		_, _ = w.Write(raw)
	})

	mux.HandleFunc("/api/v1/config/backups/import", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var imported ManagedConfig
		if err := decodeJSONBody(r, &imported); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Encore JSON backup: " + err.Error()})
			return
		}
		cs.mu.Lock()
		cs.cfg = imported
		cs.ensureSlices()
		cs.pendingChanges = true
		err := cs.saveJSONLocked()
		cs.mu.Unlock()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		cs.RecordAudit("import_json_backup", fmt.Sprintf("%d hosts, %d svcs", len(imported.Hosts), len(imported.Services)), "by="+actorFromRequest(r))
		writeJSON(w, http.StatusOK, map[string]any{
			"status":   "imported_to_draft",
			"hosts":    len(imported.Hosts),
			"services": len(imported.Services),
			"commands": len(imported.Commands),
		})
	})

	registerLegacyImportRoutes(mux, cs)

	mux.HandleFunc("/api/v1/config/validate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		out, err := cs.ValidateAndApply(false)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"valid":  false,
				"error":  err.Error(),
				"output": out,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"valid":  true,
			"output": out,
		})
	})

	mux.HandleFunc("/api/v1/config/apply", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		out, err := cs.ValidateAndApply(true)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"applied": false,
				"error":   err.Error(),
				"output":  out,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"applied": true,
			"output":  out,
		})
	})

	mux.HandleFunc("/api/v1/config/backups", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"backups": cs.ListBackups()})
	})

	mux.HandleFunc("/api/v1/config/rollback", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			Backup string `json:"backup"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		out, err := cs.Rollback(req.Backup)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error(), "output": out})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "rolled_back", "backup": req.Backup, "output": out})
	})

	mux.HandleFunc("/api/v1/audit", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > 200 {
			limit = 50
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": cs.ReadAudit(limit)})
	})
}
