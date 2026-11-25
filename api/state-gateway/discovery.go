package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type DiscoveredHost struct {
	IP                string `json:"ip"`
	Hostname          string `json:"hostname"`
	OpenPorts         []int  `json:"open_ports"`
	SuggestedTemplate string `json:"suggested_template,omitempty"`
	AlreadyManaged    bool   `json:"already_managed"`
}

var defaultProbePorts = []int{22, 80, 443, 5693, 3306, 5432}

func expandScanTargets(spec string) ([]string, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, errors.New("target IP or CIDR is required (e.g. 10.10.2.0/24 or 10.10.2.10,10.10.2.11)")
	}
	var ips []string
	seen := make(map[string]bool)
	addIP := func(ip string) error {
		if !seen[ip] {
			if len(ips) >= 254 {
				return errors.New("maximum 254 targets per scan (up to /24 subnet)")
			}
			seen[ip] = true
			ips = append(ips, ip)
		}
		return nil
	}

	for _, tok := range strings.Split(spec, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		if strings.Contains(tok, "/") {
			ip, ipnet, err := net.ParseCIDR(tok)
			if err != nil {
				return nil, fmt.Errorf("invalid CIDR %q: %w", tok, err)
			}
			ip4 := ip.To4()
			if ip4 == nil {
				return nil, fmt.Errorf("only IPv4 CIDR supported: %q", tok)
			}
			ones, bits := ipnet.Mask.Size()
			if bits-ones > 8 {
				return nil, fmt.Errorf("subnet %q too large (max /24 = 254 hosts)", tok)
			}
			start := binary.BigEndian.Uint32(ip4.Mask(ipnet.Mask))
			count := uint32(1) << uint(bits-ones)
			first, last := start+1, start+count-2
			if count <= 2 {
				first, last = start, start+count-1
			}
			for cur := first; cur <= last; cur++ {
				var b [4]byte
				binary.BigEndian.PutUint32(b[:], cur)
				if err := addIP(net.IP(b[:]).String()); err != nil {
					return nil, err
				}
			}
		} else {
			if net.ParseIP(tok) == nil {
				return nil, fmt.Errorf("invalid IP address %q", tok)
			}
			if err := addIP(tok); err != nil {
				return nil, err
			}
		}
	}
	if len(ips) == 0 {
		return nil, errors.New("no valid IP targets found")
	}
	return ips, nil
}

func runNetworkDiscovery(ctx context.Context, targets []string, ports []int, cs *ConfigStore) []DiscoveredHost {
	if len(ports) == 0 {
		ports = defaultProbePorts
	}
	managedIPs := make(map[string]bool)
	if cs != nil {
		cfg, _, _ := cs.Snapshot()
		for _, h := range cfg.Hosts {
			managedIPs[strings.TrimSpace(h.Address)] = true
		}
	}

	scanCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	sem := make(chan struct{}, 32) // Bounded worker pool (32 concurrent host probes)
	var mu sync.Mutex
	var found []DiscoveredHost
	var wg sync.WaitGroup

	for _, ip := range targets {
		ip := ip
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-scanCtx.Done():
				return
			}

			var openPorts []int
			for _, port := range ports {
				if scanCtx.Err() != nil {
					return
				}
				d := net.Dialer{Timeout: 550 * time.Millisecond}
				conn, err := d.DialContext(scanCtx, "tcp", fmt.Sprintf("%s:%d", ip, port))
				if err == nil {
					_ = conn.Close()
					openPorts = append(openPorts, port)
				}
			}
			if len(openPorts) == 0 {
				return
			}

			hostname := "host-" + strings.ReplaceAll(ip, ".", "-")
			rCtx, rCancel := context.WithTimeout(scanCtx, 400*time.Millisecond)
			if names, err := net.DefaultResolver.LookupAddr(rCtx, ip); err == nil && len(names) > 0 {
				hostname = strings.TrimSuffix(names[0], ".")
			}
			rCancel()

			suggested := ""
			hasPort := func(p int) bool {
				for _, op := range openPorts {
					if op == p {
						return true
					}
				}
				return false
			}
			if hasPort(5693) {
				suggested = "linux-ncpa-basic"
			} else if hasPort(443) || hasPort(80) {
				suggested = "web-https-stack"
			}

			mu.Lock()
			found = append(found, DiscoveredHost{
				IP:                ip,
				Hostname:          hostname,
				OpenPorts:         openPorts,
				SuggestedTemplate: suggested,
				AlreadyManaged:    managedIPs[ip],
			})
			mu.Unlock()
		}()
	}
	wg.Wait()

	sort.Slice(found, func(i, j int) bool { return found[i].IP < found[j].IP })
	return found
}

func registerDiscoveryRoutes(mux *http.ServeMux, cs *ConfigStore) {
	mux.HandleFunc("/api/v1/discovery/scan", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req struct {
			Target string `json:"target"`
			Ports  []int  `json:"ports,omitempty"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		targets, err := expandScanTargets(req.Target)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		t0 := time.Now()
		hosts := runNetworkDiscovery(r.Context(), targets, req.Ports, cs)
		if cs != nil {
			cs.RecordAudit("discovery_scan", req.Target, fmt.Sprintf("scanned=%d found=%d by=%s", len(targets), len(hosts), actorFromRequest(r)))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"scanned":     len(targets),
			"found":       len(hosts),
			"duration_ms": time.Since(t0).Milliseconds(),
			"hosts":       hosts,
		})
	})
}
