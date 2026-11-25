package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	RoleViewer   = "viewer"
	RoleOperator = "operator"
	RoleAdmin    = "admin"

	pbkdf2Iterations = 100000
	sessionCookie    = "encore_session"
	sessionTTL       = 12 * time.Hour
)

type ctxKey string

const actorCtxKey ctxKey = "encore_actor"

type UserRecord struct {
	Username     string `json:"username"`
	DisplayName  string `json:"display_name"`
	Role         string `json:"role"` // viewer, operator, admin
	Enabled      bool   `json:"enabled"`
	PasswordHash string `json:"password_hash"` // pbkdf2$100000$<b64salt>$<b64dk>
	CreatedAt    string `json:"created_at"`
	LastLogin    string `json:"last_login,omitempty"`
}

type PublicUser struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Enabled     bool   `json:"enabled"`
	CreatedAt   string `json:"created_at"`
	LastLogin   string `json:"last_login,omitempty"`
}

type SessionInfo struct {
	Token    string
	Username string
	Role     string
	Expires  time.Time
}

type basicCacheEntry struct {
	user    UserRecord
	expires time.Time
}

type AuthManager struct {
	mu         sync.RWMutex
	enabled    bool
	filePath   string
	cs         *ConfigStore
	users      map[string]*UserRecord
	sessions   map[string]*SessionInfo
	attempts   map[string][]time.Time // IP -> failed timestamps
	basicCache map[string]basicCacheEntry
}

func isValidRole(r string) bool {
	return r == RoleViewer || r == RoleOperator || r == RoleAdmin
}

func roleLevel(r string) int {
	switch r {
	case RoleAdmin:
		return 3
	case RoleOperator:
		return 2
	case RoleViewer:
		return 1
	default:
		return 0
	}
}

// Pure Go stdlib PBKDF2-HMAC-SHA256 (RFC 2898)
func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := func(key, data []byte) []byte {
		h := hmac.New(sha256.New, key)
		h.Write(data)
		return h.Sum(nil)
	}
	hashLen := 32
	numBlocks := (keyLen + hashLen - 1) / hashLen
	var buf [4]byte
	dk := make([]byte, 0, numBlocks*hashLen)
	for block := 1; block <= numBlocks; block++ {
		binary.BigEndian.PutUint32(buf[:], uint32(block))
		in := make([]byte, 0, len(salt)+4)
		in = append(in, salt...)
		in = append(in, buf[:]...)
		u := prf(password, in)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 2; i <= iter; i++ {
			u = prf(password, u)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		dk = append(dk, t...)
	}
	return dk[:keyLen]
}

func hashPassword(password string) (string, error) {
	if len(password) < 4 {
		return "", errors.New("password must be at least 4 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk := pbkdf2SHA256([]byte(password), salt, pbkdf2Iterations, 32)
	return fmt.Sprintf("pbkdf2$%d$%s$%s",
		pbkdf2Iterations,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(dk),
	), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	var iter int
	if _, err := fmt.Sscanf(parts[1], "%d", &iter); err != nil || iter < 1000 || iter > 1000000 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(password), salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func randomTokenHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func NewAuthManager(managedDir, seedUser, seedPass string, cs *ConfigStore) *AuthManager {
	am := &AuthManager{
		cs:         cs,
		users:      make(map[string]*UserRecord),
		sessions:   make(map[string]*SessionInfo),
		attempts:   make(map[string][]time.Time),
		basicCache: make(map[string]basicCacheEntry),
	}
	if managedDir != "" {
		am.filePath = filepath.Join(managedDir, "encore-users.json")
		if raw, err := os.ReadFile(am.filePath); err == nil && len(raw) > 0 {
			var list []*UserRecord
			if json.Unmarshal(raw, &list) == nil {
				for _, u := range list {
					if u.Username != "" {
						am.users[u.Username] = u
					}
				}
			}
		}
	}

	if seedUser != "" && seedPass != "" {
		am.enabled = true
		if _, exists := am.users[seedUser]; !exists {
			if h, err := hashPassword(seedPass); err == nil {
				am.users[seedUser] = &UserRecord{
					Username:     seedUser,
					DisplayName:  strings.ToUpper(seedUser[:1]) + seedUser[1:],
					Role:         RoleAdmin,
					Enabled:      true,
					PasswordHash: h,
					CreatedAt:    time.Now().UTC().Format(time.RFC3339),
				}
				_ = am.saveLocked()
			}
		}
	} else if len(am.users) > 0 {
		am.enabled = true
	}
	return am
}

func (am *AuthManager) saveLocked() error {
	if am.filePath == "" {
		return nil
	}
	list := make([]*UserRecord, 0, len(am.users))
	for _, u := range am.users {
		list = append(list, u)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Username < list[j].Username })
	raw, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := am.filePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, am.filePath)
}

func (am *AuthManager) IsEnabled() bool {
	am.mu.RLock()
	defer am.mu.RUnlock()
	return am.enabled
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (am *AuthManager) checkRateLimit(ip string) bool {
	am.mu.Lock()
	defer am.mu.Unlock()
	cutoff := time.Now().Add(-5 * time.Minute)
	recent := am.attempts[ip][:0]
	for _, ts := range am.attempts[ip] {
		if ts.After(cutoff) {
			recent = append(recent, ts)
		}
	}
	am.attempts[ip] = recent
	return len(recent) < 10
}

func (am *AuthManager) recordFailedAttempt(ip string) {
	am.mu.Lock()
	defer am.mu.Unlock()
	am.attempts[ip] = append(am.attempts[ip], time.Now())
}

func (am *AuthManager) AuthenticateCredentials(username, password string) (*UserRecord, bool) {
	am.mu.Lock()
	defer am.mu.Unlock()
	u, ok := am.users[username]
	if !ok || !u.Enabled {
		return nil, false
	}
	if !verifyPassword(u.PasswordHash, password) {
		return nil, false
	}
	u.LastLogin = time.Now().UTC().Format(time.RFC3339)
	_ = am.saveLocked()
	cp := *u
	return &cp, true
}

func (am *AuthManager) CreateSession(u *UserRecord) string {
	tok := randomTokenHex(32)
	am.mu.Lock()
	am.sessions[tok] = &SessionInfo{
		Token:    tok,
		Username: u.Username,
		Role:     u.Role,
		Expires:  time.Now().Add(sessionTTL),
	}
	am.mu.Unlock()
	return tok
}

func (am *AuthManager) RevokeSession(tok string) {
	am.mu.Lock()
	delete(am.sessions, tok)
	am.mu.Unlock()
}

func (am *AuthManager) RevokeUserSessions(username string) {
	am.mu.Lock()
	for k, s := range am.sessions {
		if s.Username == username {
			delete(am.sessions, k)
		}
	}
	am.mu.Unlock()
}

func (am *AuthManager) AuthenticateRequest(r *http.Request) (*UserRecord, bool) {
	am.mu.RLock()
	enabled := am.enabled
	am.mu.RUnlock()
	if !enabled {
		return &UserRecord{Username: "local-admin", DisplayName: "Local Admin", Role: RoleAdmin, Enabled: true}, true
	}

	// 1. Check session cookie
	if ck, err := r.Cookie(sessionCookie); err == nil && ck.Value != "" {
		am.mu.Lock()
		sess, ok := am.sessions[ck.Value]
		if ok && time.Now().Before(sess.Expires) {
			if u, uok := am.users[sess.Username]; uok && u.Enabled {
				sess.Expires = time.Now().Add(sessionTTL) // sliding expiry
				cp := *u
				am.mu.Unlock()
				return &cp, true
			}
		} else if ok {
			delete(am.sessions, ck.Value)
		}
		am.mu.Unlock()
	}

	// 2. Fallback to HTTP Basic Auth (automation / curl / legacy browser cache)
	// Uses a 5-min SHA-256 verified cache + runs PBKDF2 outside lock to avoid 400ms stalls.
	if u, p, ok := r.BasicAuth(); ok {
		am.mu.RLock()
		rec, exists := am.users[u]
		if !exists || !rec.Enabled {
			am.mu.RUnlock()
			return nil, false
		}
		cp := *rec
		am.mu.RUnlock()

		sum := sha256.Sum256([]byte(u + "\x00" + p + "\x00" + cp.PasswordHash))
		ck := hex.EncodeToString(sum[:])

		am.mu.RLock()
		ce, hit := am.basicCache[ck]
		am.mu.RUnlock()
		if hit && time.Now().Before(ce.expires) {
			uc := ce.user
			return &uc, true
		}

		if verifyPassword(cp.PasswordHash, p) {
			am.mu.Lock()
			am.basicCache[ck] = basicCacheEntry{user: cp, expires: time.Now().Add(5 * time.Minute)}
			am.mu.Unlock()
			return &cp, true
		}
	}

	return nil, false
}

func actorFromRequest(r *http.Request) string {
	if u, ok := r.Context().Value(actorCtxKey).(*UserRecord); ok && u != nil {
		return u.Username + " (" + u.Role + ")"
	}
	return ""
}

// Required RBAC role for a given HTTP method + path
func requiredRoleForRoute(method, path string) string {
	// Public routes handled before RBAC
	if path == "/healthz" || path == "/login" || path == "/favicon.ico" ||
		strings.HasPrefix(path, "/assets/") || strings.HasPrefix(path, "/css/") || strings.HasPrefix(path, "/js/") ||
		path == "/api/v1/auth/login" || path == "/api/v1/auth/logout" {
		return ""
	}
	// Self-service authenticated routes
	if path == "/api/v1/auth/me" || path == "/api/v1/auth/password" {
		return RoleViewer
	}
	// Admin-only read & write routes (sensitive data & config management)
	if strings.HasPrefix(path, "/api/v1/users") ||
		strings.HasPrefix(path, "/api/v1/secrets") ||
		strings.HasPrefix(path, "/api/v1/notifications") ||
		strings.HasPrefix(path, "/api/v1/scripts") {
		return RoleAdmin
	}
	if strings.HasPrefix(path, "/api/v1/config") {
		if method == http.MethodGet && (path == "/api/v1/config" || path == "/api/v1/config/diff") {
			return RoleAdmin
		}
		return RoleAdmin
	}
	// Operator actions (Force Check, ACK, Downtime, Recurring Downtime)
	if path == "/api/v1/command" || path == "/api/v1/commands/batch" {
		return RoleOperator
	}
	if path == "/api/v1/downtimes/recurring" && method != http.MethodGet {
		return RoleOperator
	}
	// Default: any write method requires admin; read methods require viewer
	if method != http.MethodGet && method != http.MethodHead {
		return RoleAdmin
	}
	return RoleViewer
}

func (am *AuthManager) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqRole := requiredRoleForRoute(r.Method, r.URL.Path)
		if reqRole == "" {
			next.ServeHTTP(w, r)
			return
		}
		u, ok := am.AuthenticateRequest(r)
		if !ok {
			// Redirect browser HTML requests to /login; return 401 JSON for API
			if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/health" && strings.Contains(r.Header.Get("Accept"), "text/html") {
				http.Redirect(w, r, "/login", http.StatusFound)
				return
			}
			w.Header().Set("WWW-Authenticate", `Basic realm="Encore Monitor"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
			return
		}
		if roleLevel(u.Role) < roleLevel(reqRole) {
			writeJSON(w, http.StatusForbidden, map[string]string{
				"error": fmt.Sprintf("forbidden: requires %s role (your role: %s)", reqRole, u.Role),
			})
			return
		}
		ctx := context.WithValue(r.Context(), actorCtxKey, u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (am *AuthManager) ListUsers() []PublicUser {
	am.mu.RLock()
	defer am.mu.RUnlock()
	out := make([]PublicUser, 0, len(am.users))
	for _, u := range am.users {
		out = append(out, PublicUser{
			Username:    u.Username,
			DisplayName: u.DisplayName,
			Role:        u.Role,
			Enabled:     u.Enabled,
			CreatedAt:   u.CreatedAt,
			LastLogin:   u.LastLogin,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out
}

func (am *AuthManager) activeAdminCountLocked(excludeUser string) int {
	cnt := 0
	for _, u := range am.users {
		if u.Username != excludeUser && u.Enabled && u.Role == RoleAdmin {
			cnt++
		}
	}
	return cnt
}

func (am *AuthManager) UpsertUser(username, displayName, role, password string, enabled bool, actor string) error {
	username = strings.TrimSpace(strings.ToLower(username))
	if err := sanitizeName(username); err != nil {
		return fmt.Errorf("username: %w", err)
	}
	if !isValidRole(role) {
		return fmt.Errorf("invalid role %q (must be viewer, operator, or admin)", role)
	}
	if displayName == "" {
		displayName = username
	}

	am.mu.Lock()
	defer am.mu.Unlock()

	existing, exists := am.users[username]
	if exists {
		// Prevent demoting or disabling the last active admin
		if existing.Role == RoleAdmin && existing.Enabled && (role != RoleAdmin || !enabled) {
			if am.activeAdminCountLocked(username) == 0 {
				return errors.New("cannot disable or demote the last active admin user")
			}
		}
		existing.DisplayName = displayName
		existing.Role = role
		existing.Enabled = enabled
		if password != "" {
			h, err := hashPassword(password)
			if err != nil {
				return err
			}
			existing.PasswordHash = h
		}
		if !enabled || password != "" {
			for k, s := range am.sessions {
				if s.Username == username {
					delete(am.sessions, k)
				}
			}
			am.basicCache = make(map[string]basicCacheEntry)
		}
	} else {
		h, err := hashPassword(password)
		if err != nil {
			return err
		}
		am.users[username] = &UserRecord{
			Username:     username,
			DisplayName:  displayName,
			Role:         role,
			Enabled:      enabled,
			PasswordHash: h,
			CreatedAt:    time.Now().UTC().Format(time.RFC3339),
		}
		am.enabled = true
	}

	if err := am.saveLocked(); err != nil {
		return err
	}
	if am.cs != nil {
		am.cs.RecordAudit("upsert_user", username, fmt.Sprintf("role=%s enabled=%v by=%s", role, enabled, actor))
	}
	return nil
}

func (am *AuthManager) DeleteUser(username, actor string) error {
	username = strings.TrimSpace(strings.ToLower(username))
	am.mu.Lock()
	defer am.mu.Unlock()
	u, ok := am.users[username]
	if !ok {
		return fmt.Errorf("user %q not found", username)
	}
	if u.Role == RoleAdmin && u.Enabled && am.activeAdminCountLocked(username) == 0 {
		return errors.New("cannot delete the last active admin user")
	}
	delete(am.users, username)
	for k, s := range am.sessions {
		if s.Username == username {
			delete(am.sessions, k)
		}
	}
	am.basicCache = make(map[string]basicCacheEntry)
	if err := am.saveLocked(); err != nil {
		return err
	}
	if am.cs != nil {
		am.cs.RecordAudit("delete_user", username, "by="+actor)
	}
	return nil
}

func (am *AuthManager) ChangeOwnPassword(username, oldPass, newPass string) error {
	am.mu.Lock()
	defer am.mu.Unlock()
	u, ok := am.users[username]
	if !ok {
		return errors.New("user not found")
	}
	if !verifyPassword(u.PasswordHash, oldPass) {
		return errors.New("current password is incorrect")
	}
	h, err := hashPassword(newPass)
	if err != nil {
		return err
	}
	u.PasswordHash = h
	am.basicCache = make(map[string]basicCacheEntry)
	return am.saveLocked()
}

func registerAuthRoutes(mux *http.ServeMux, am *AuthManager) {
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/login.html")
		if err != nil {
			http.Error(w, "login page missing", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	})

	mux.HandleFunc("/api/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		ip := clientIP(r)
		if !am.checkRateLimit(ip) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many failed login attempts, try again in 5 minutes"})
			return
		}
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		u, ok := am.AuthenticateCredentials(strings.TrimSpace(strings.ToLower(req.Username)), req.Password)
		if !ok {
			am.recordFailedAttempt(ip)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
			return
		}
		tok := am.CreateSession(u)
		isHTTPS := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookie,
			Value:    tok,
			Path:     "/",
			HttpOnly: true,
			Secure:   isHTTPS,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   int(sessionTTL.Seconds()),
		})
		if am.cs != nil {
			am.cs.RecordAudit("login", u.Username, "role="+u.Role+" ip="+ip)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"user": PublicUser{
				Username:    u.Username,
				DisplayName: u.DisplayName,
				Role:        u.Role,
				Enabled:     u.Enabled,
			},
		})
	})

	mux.HandleFunc("/api/v1/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if ck, err := r.Cookie(sessionCookie); err == nil && ck.Value != "" {
			am.RevokeSession(ck.Value)
		}
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookie,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			MaxAge:   -1,
		})
		writeJSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
	})

	mux.HandleFunc("/api/v1/auth/me", func(w http.ResponseWriter, r *http.Request) {
		u, _ := r.Context().Value(actorCtxKey).(*UserRecord)
		if u == nil {
			u = &UserRecord{Username: "local-admin", DisplayName: "Local Admin", Role: RoleAdmin, Enabled: true}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"auth_enabled": am.IsEnabled(),
			"user": PublicUser{
				Username:    u.Username,
				DisplayName: u.DisplayName,
				Role:        u.Role,
				Enabled:     u.Enabled,
				LastLogin:   u.LastLogin,
			},
		})
	})

	mux.HandleFunc("/api/v1/auth/password", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		u, _ := r.Context().Value(actorCtxKey).(*UserRecord)
		if u == nil || !am.IsEnabled() {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "authentication is not enabled"})
			return
		}
		var req struct {
			CurrentPassword string `json:"current_password"`
			NewPassword     string `json:"new_password"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := am.ChangeOwnPassword(u.Username, req.CurrentPassword, req.NewPassword); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "password_updated"})
	})

	mux.HandleFunc("/api/v1/users", func(w http.ResponseWriter, r *http.Request) {
		actor := actorFromRequest(r)
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{
				"auth_enabled": am.IsEnabled(),
				"users":        am.ListUsers(),
			})
		case http.MethodPost, http.MethodPut:
			var req struct {
				Username    string `json:"username"`
				DisplayName string `json:"display_name"`
				Role        string `json:"role"`
				Password    string `json:"password"`
				Enabled     *bool  `json:"enabled"`
			}
			if err := decodeJSONBody(r, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			en := true
			if req.Enabled != nil {
				en = *req.Enabled
			}
			if err := am.UpsertUser(req.Username, req.DisplayName, req.Role, req.Password, en, actor); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
		case http.MethodDelete:
			username := r.URL.Query().Get("username")
			if err := am.DeleteUser(username, actor); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})
}
