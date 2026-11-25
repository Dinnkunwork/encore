package main

import (
	"compress/gzip"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MetricPoint struct {
	TS  int64   `json:"ts"`
	Val float64 `json:"v"`
}

type MetricSeries struct {
	Label  string        `json:"label"`
	Unit   string        `json:"unit,omitempty"`
	Warn   *float64      `json:"warn,omitempty"`
	Crit   *float64      `json:"crit,omitempty"`
	Points []MetricPoint `json:"points"`
}

type MetricSeriesResponse struct {
	Label  string        `json:"label"`
	Unit   string        `json:"unit,omitempty"`
	Warn   *float64      `json:"warn,omitempty"`
	Crit   *float64      `json:"crit,omitempty"`
	Min    float64       `json:"min"`
	Avg    float64       `json:"avg"`
	Max    float64       `json:"max"`
	Last   float64       `json:"last"`
	Points []MetricPoint `json:"points"`
}

type MetricsStore struct {
	mu       sync.RWMutex
	filePath string
	// key: host + "\x00" + service -> label -> *MetricSeries
	data map[string]map[string]*MetricSeries
}

func NewMetricsStore(managedDir string) *MetricsStore {
	ms := &MetricsStore{
		data: make(map[string]map[string]*MetricSeries),
	}
	if managedDir != "" {
		ms.filePath = filepath.Join(managedDir, "encore-metrics.json.gz")
		ms.loadFromDisk()
	}
	return ms
}

func (ms *MetricsStore) loadFromDisk() {
	f, err := os.Open(ms.filePath)
	if err != nil {
		return
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return
	}
	defer gz.Close()
	var loaded map[string]map[string]*MetricSeries
	if json.NewDecoder(gz).Decode(&loaded) == nil && loaded != nil {
		ms.mu.Lock()
		ms.data = loaded
		ms.mu.Unlock()
	}
}

func (ms *MetricsStore) SaveToDisk() error {
	if ms.filePath == "" {
		return nil
	}
	ms.mu.RLock()
	raw, err := json.Marshal(ms.data)
	ms.mu.RUnlock()
	if err != nil {
		return err
	}
	tmp := ms.filePath + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	_, werr := gz.Write(raw)
	cerr := gz.Close()
	ferr := f.Close()
	if werr != nil || cerr != nil || ferr != nil {
		_ = os.Remove(tmp)
		return werr
	}
	return os.Rename(tmp, ms.filePath)
}

func splitNumUnit(s string) (float64, string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, "", false
	}
	i := 0
	for i < len(s) {
		ch := s[i]
		if (ch >= '0' && ch <= '9') || ch == '.' || ch == '-' || ch == '+' {
			i++
		} else {
			break
		}
	}
	if i == 0 {
		return 0, "", false
	}
	v, err := strconv.ParseFloat(s[:i], 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, "", false
	}
	return v, strings.TrimSpace(s[i:]), true
}

func parseThreshold(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	// Handle simple Nagios ranges like "80", "0:80", "@10:20" -> take upper numeric bound
	s = strings.TrimPrefix(s, "@")
	if idx := strings.LastIndexByte(s, ':'); idx >= 0 && idx+1 < len(s) {
		s = s[idx+1:]
	}
	v, _, ok := splitNumUnit(s)
	if !ok {
		return nil
	}
	return &v
}

// Parse standard Nagios perf_data: 'label'=value[UOM];[warn];[crit];[min];[max]
func parsePerfDataTokens(perf string) []struct {
	Label string
	Val   float64
	Unit  string
	Warn  *float64
	Crit  *float64
} {
	perf = strings.TrimSpace(perf)
	if perf == "" {
		return nil
	}
	var tokens []string
	var cur strings.Builder
	inQuote := false
	for i := 0; i < len(perf); i++ {
		ch := perf[i]
		if ch == '\'' {
			inQuote = !inQuote
			cur.WriteByte(ch)
		} else if !inQuote && (ch == ' ' || ch == '\t') {
			if cur.Len() > 0 {
				tokens = append(tokens, cur.String())
				cur.Reset()
			}
		} else {
			cur.WriteByte(ch)
		}
	}
	if cur.Len() > 0 {
		tokens = append(tokens, cur.String())
	}

	var out []struct {
		Label string
		Val   float64
		Unit  string
		Warn  *float64
		Crit  *float64
	}
	for _, tok := range tokens {
		eq := strings.IndexByte(tok, '=')
		if eq <= 0 {
			continue
		}
		label := strings.Trim(tok[:eq], "'\"")
		rest := tok[eq+1:]
		parts := strings.Split(rest, ";")
		val, unit, ok := splitNumUnit(parts[0])
		if !ok {
			continue
		}
		var warn, crit *float64
		if len(parts) > 1 {
			warn = parseThreshold(parts[1])
		}
		if len(parts) > 2 {
			crit = parseThreshold(parts[2])
		}
		out = append(out, struct {
			Label string
			Val   float64
			Unit  string
			Warn  *float64
			Crit  *float64
		}{Label: label, Val: val, Unit: unit, Warn: warn, Crit: crit})
	}
	return out
}

func (ms *MetricsStore) Record(host, service, perfData string, ts int64) {
	if ms == nil || strings.TrimSpace(perfData) == "" {
		return
	}
	parsed := parsePerfDataTokens(perfData)
	if len(parsed) == 0 {
		return
	}
	if ts <= 0 {
		ts = time.Now().Unix()
	}
	key := svcKey(host, service)
	cutoff := ts - 7*86400

	ms.mu.Lock()
	defer ms.mu.Unlock()
	byLabel, ok := ms.data[key]
	if !ok {
		byLabel = make(map[string]*MetricSeries)
		ms.data[key] = byLabel
	}
	for _, p := range parsed {
		ser, exists := byLabel[p.Label]
		if !exists {
			ser = &MetricSeries{Label: p.Label, Unit: p.Unit, Warn: p.Warn, Crit: p.Crit}
			byLabel[p.Label] = ser
		} else {
			if p.Unit != "" {
				ser.Unit = p.Unit
			}
			if p.Warn != nil {
				ser.Warn = p.Warn
			}
			if p.Crit != nil {
				ser.Crit = p.Crit
			}
		}
		// Deduplicate identical timestamp
		if n := len(ser.Points); n > 0 && ser.Points[n-1].TS == ts {
			ser.Points[n-1].Val = p.Val
			continue
		}
		ser.Points = append(ser.Points, MetricPoint{TS: ts, Val: p.Val})
		// Trim points older than 7 days or cap at 2016 points (~5m interval for 7 days)
		if len(ser.Points) > 2100 {
			drop := 0
			for drop < len(ser.Points) && ser.Points[drop].TS < cutoff {
				drop++
			}
			if drop == 0 {
				drop = len(ser.Points) - 2016
			}
			ser.Points = append([]MetricPoint(nil), ser.Points[drop:]...)
		}
	}
}

func (ms *MetricsStore) Query(host, service string, fromTS, toTS int64) []MetricSeriesResponse {
	if ms == nil {
		return []MetricSeriesResponse{}
	}
	key := svcKey(host, service)
	ms.mu.RLock()
	byLabel := ms.data[key]
	if len(byLabel) == 0 {
		ms.mu.RUnlock()
		return []MetricSeriesResponse{}
	}
	out := make([]MetricSeriesResponse, 0, len(byLabel))
	for _, ser := range byLabel {
		var pts []MetricPoint
		for _, pt := range ser.Points {
			if pt.TS >= fromTS && pt.TS <= toTS {
				pts = append(pts, pt)
			}
		}
		if len(pts) == 0 && len(ser.Points) > 0 {
			// Include latest point so chart still shows current value
			pts = append(pts, ser.Points[len(ser.Points)-1])
		}
		if len(pts) == 0 {
			continue
		}
		minV, maxV, sumV := pts[0].Val, pts[0].Val, 0.0
		for _, pt := range pts {
			if pt.Val < minV {
				minV = pt.Val
			}
			if pt.Val > maxV {
				maxV = pt.Val
			}
			sumV += pt.Val
		}
		// Downsample to <= 120 points for crisp, fast SVG rendering
		if len(pts) > 120 {
			step := float64(len(pts)) / 120.0
			ds := make([]MetricPoint, 0, 120)
			for i := 0; i < 120; i++ {
				idx := int(float64(i) * step)
				if idx >= len(pts) {
					idx = len(pts) - 1
				}
				ds = append(ds, pts[idx])
			}
			pts = ds
		}
		out = append(out, MetricSeriesResponse{
			Label:  ser.Label,
			Unit:   ser.Unit,
			Warn:   ser.Warn,
			Crit:   ser.Crit,
			Min:    round2(minV),
			Avg:    round2(sumV / float64(len(pts))),
			Max:    round2(maxV),
			Last:   round2(pts[len(pts)-1].Val),
			Points: pts,
		})
	}
	ms.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

func registerMetricsRoutes(mux *http.ServeMux, ms *MetricsStore) {
	mux.HandleFunc("/api/v1/metrics", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		host := q.Get("host")
		svc := q.Get("service")
		rng := q.Get("range")
		now := time.Now().Unix()
		var dur int64 = 86400
		switch rng {
		case "1h":
			dur = 3600
		case "6h":
			dur = 6 * 3600
		case "24h", "":
			dur = 86400
		case "7d":
			dur = 7 * 86400
		}
		series := ms.Query(host, svc, now-dur, now)
		writeJSON(w, http.StatusOK, map[string]any{
			"host":    host,
			"service": svc,
			"range":   rng,
			"series":  series,
		})
	})
}
