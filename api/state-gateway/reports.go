package main

import (
	"bufio"
	"encoding/csv"
	"fmt"
	"html"
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

type logCacheEntry struct {
	sig     string
	expires time.Time
	events  []LogEvent
}

var (
	logCacheMu sync.RWMutex
	logCache   = make(map[string]logCacheEntry)
)

type LogEvent struct {
	Timestamp int64  `json:"timestamp"`
	Type      string `json:"type"` // host_alert, service_alert, notification, downtime, system
	Host      string `json:"host,omitempty"`
	Service   string `json:"service,omitempty"`
	State     string `json:"state,omitempty"`
	StateType string `json:"state_type,omitempty"`
	Attempt   string `json:"attempt,omitempty"`
	Contact   string `json:"contact,omitempty"`
	Message   string `json:"message"`
}

type AvailabilityRow struct {
	Host          string  `json:"host"`
	Service       string  `json:"service,omitempty"`
	OKPct         float64 `json:"ok_pct"`
	WarnPct       float64 `json:"warn_pct"`
	CritPct       float64 `json:"crit_pct"`
	UnkPct        float64 `json:"unk_pct"`
	DowntimePct   float64 `json:"downtime_pct"`
	OKSec         float64 `json:"ok_sec"`
	ProblemSec    float64 `json:"problem_sec"`
	Incidents     int     `json:"incidents"`
	CritIncidents int     `json:"crit_incidents"`
	WarnIncidents int     `json:"warn_incidents"`
	MTTRSec       float64 `json:"mttr_sec"`
}

type AvailabilitySummary struct {
	From            int64   `json:"from"`
	To              int64   `json:"to"`
	Target          string  `json:"target"`
	TotalObjects    int     `json:"total_objects"`
	OverallSLAPct   float64 `json:"overall_sla_pct"`
	WarnPct         float64 `json:"warn_pct"`
	CritPct         float64 `json:"crit_pct"`
	UnkPct          float64 `json:"unk_pct"`
	DowntimePct     float64 `json:"downtime_pct"`
	TotalProblemSec float64 `json:"total_problem_sec"`
	TotalIncidents  int     `json:"total_incidents"`
	CritIncidents   int     `json:"crit_incidents"`
	WarnIncidents   int     `json:"warn_incidents"`
	AvgMTTRSec      float64 `json:"avg_mttr_sec"`
	LogEventsUsed   int     `json:"log_events_used"`
}

type TimelineBucket struct {
	Timestamp     int64   `json:"timestamp"`
	Label         string  `json:"label"`
	OKPct         float64 `json:"ok_pct"`
	WarnPct       float64 `json:"warn_pct"`
	CritPct       float64 `json:"crit_pct"`
	UnkPct        float64 `json:"unk_pct"`
	Incidents     int     `json:"incidents"`
	CritIncidents int     `json:"crit_incidents"`
	WarnIncidents int     `json:"warn_incidents"`
}

func collectLogFiles(nagiosLog, archivesDir string, from, to int64) []string {
	var files []string
	if archivesDir != "" {
		if entries, err := os.ReadDir(archivesDir); err == nil {
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
					continue
				}
				p := filepath.Join(archivesDir, e.Name())
				info, err := e.Info()
				if err != nil {
					continue
				}
				// Include archive if modified after (from - 48h)
				if info.ModTime().Unix() >= from-172800 {
					files = append(files, p)
				}
			}
		}
	}
	sort.Strings(files)
	if nagiosLog != "" {
		if _, err := os.Stat(nagiosLog); err == nil {
			files = append(files, nagiosLog)
		}
	}
	return files
}

func parseNagiosLogLine(line string) (LogEvent, bool) {
	if len(line) < 13 || line[0] != '[' {
		return LogEvent{}, false
	}
	rb := strings.IndexByte(line, ']')
	if rb <= 1 {
		return LogEvent{}, false
	}
	ts, err := strconv.ParseInt(line[1:rb], 10, 64)
	if err != nil {
		return LogEvent{}, false
	}
	rest := strings.TrimSpace(line[rb+1:])
	ev := LogEvent{Timestamp: ts, Type: "system", Message: rest}

	switch {
	case strings.HasPrefix(rest, "HOST ALERT: "):
		parts := strings.SplitN(strings.TrimPrefix(rest, "HOST ALERT: "), ";", 5)
		if len(parts) >= 4 {
			ev.Type = "host_alert"
			ev.Host = parts[0]
			ev.State = parts[1]
			ev.StateType = parts[2]
			ev.Attempt = parts[3]
			if len(parts) >= 5 {
				ev.Message = parts[4]
			}
		}
	case strings.HasPrefix(rest, "INITIAL HOST STATE: "), strings.HasPrefix(rest, "CURRENT HOST STATE: "):
		body := strings.TrimPrefix(strings.TrimPrefix(rest, "INITIAL HOST STATE: "), "CURRENT HOST STATE: ")
		parts := strings.SplitN(body, ";", 5)
		if len(parts) >= 4 {
			ev.Type = "host_state"
			ev.Host = parts[0]
			ev.State = parts[1]
			ev.StateType = parts[2]
			ev.Attempt = parts[3]
			if len(parts) >= 5 {
				ev.Message = parts[4]
			}
		}
	case strings.HasPrefix(rest, "SERVICE ALERT: "):
		parts := strings.SplitN(strings.TrimPrefix(rest, "SERVICE ALERT: "), ";", 6)
		if len(parts) >= 5 {
			ev.Type = "service_alert"
			ev.Host = parts[0]
			ev.Service = parts[1]
			ev.State = parts[2]
			ev.StateType = parts[3]
			ev.Attempt = parts[4]
			if len(parts) >= 6 {
				ev.Message = parts[5]
			}
		}
	case strings.HasPrefix(rest, "INITIAL SERVICE STATE: "), strings.HasPrefix(rest, "CURRENT SERVICE STATE: "):
		body := strings.TrimPrefix(strings.TrimPrefix(rest, "INITIAL SERVICE STATE: "), "CURRENT SERVICE STATE: ")
		parts := strings.SplitN(body, ";", 6)
		if len(parts) >= 5 {
			ev.Type = "service_state"
			ev.Host = parts[0]
			ev.Service = parts[1]
			ev.State = parts[2]
			ev.StateType = parts[3]
			ev.Attempt = parts[4]
			if len(parts) >= 6 {
				ev.Message = parts[5]
			}
		}
	case strings.HasPrefix(rest, "HOST NOTIFICATION: "):
		parts := strings.SplitN(strings.TrimPrefix(rest, "HOST NOTIFICATION: "), ";", 5)
		if len(parts) >= 4 {
			ev.Type = "notification"
			ev.Contact = parts[0]
			ev.Host = parts[1]
			ev.State = parts[2]
			if len(parts) >= 5 {
				ev.Message = parts[4]
			}
		}
	case strings.HasPrefix(rest, "SERVICE NOTIFICATION: "):
		parts := strings.SplitN(strings.TrimPrefix(rest, "SERVICE NOTIFICATION: "), ";", 6)
		if len(parts) >= 5 {
			ev.Type = "notification"
			ev.Contact = parts[0]
			ev.Host = parts[1]
			ev.Service = parts[2]
			ev.State = parts[3]
			if len(parts) >= 6 {
				ev.Message = parts[5]
			}
		}
	case strings.HasPrefix(rest, "HOST DOWNTIME ALERT: "):
		parts := strings.SplitN(strings.TrimPrefix(rest, "HOST DOWNTIME ALERT: "), ";", 3)
		if len(parts) >= 2 {
			ev.Type = "downtime"
			ev.Host = parts[0]
			ev.State = parts[1]
			if len(parts) >= 3 {
				ev.Message = parts[2]
			}
		}
	case strings.HasPrefix(rest, "SERVICE DOWNTIME ALERT: "):
		parts := strings.SplitN(strings.TrimPrefix(rest, "SERVICE DOWNTIME ALERT: "), ";", 4)
		if len(parts) >= 3 {
			ev.Type = "downtime"
			ev.Host = parts[0]
			ev.Service = parts[1]
			ev.State = parts[2]
			if len(parts) >= 4 {
				ev.Message = parts[3]
			}
		}
	}
	return ev, true
}

func readLogEvents(nagiosLog, archivesDir string, from, to int64) []LogEvent {
	files := collectLogFiles(nagiosLog, archivesDir, from, to)
	// Build lightweight cache signature from active log mtime/size + archive file count
	var sigB strings.Builder
	fmt.Fprintf(&sigB, "%d|%d|%d", from/60, to/60, len(files))
	if nagiosLog != "" {
		if st, err := os.Stat(nagiosLog); err == nil {
			fmt.Fprintf(&sigB, "|%d|%d", st.ModTime().UnixNano(), st.Size())
		}
	}
	cacheKey := nagiosLog + "|" + archivesDir + "|" + sigB.String()

	logCacheMu.RLock()
	if ce, ok := logCache[cacheKey]; ok && time.Now().Before(ce.expires) {
		logCacheMu.RUnlock()
		return ce.events
	}
	logCacheMu.RUnlock()

	var events []LogEvent
	for _, p := range files {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			ev, ok := parseNagiosLogLine(sc.Text())
			if !ok {
				continue
			}
			if ev.Timestamp < from || ev.Timestamp > to {
				continue
			}
			events = append(events, ev)
		}
		_ = f.Close()
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Timestamp < events[j].Timestamp })

	logCacheMu.Lock()
	if len(logCache) > 16 {
		logCache = make(map[string]logCacheEntry)
	}
	logCache[cacheKey] = logCacheEntry{sig: cacheKey, expires: time.Now().Add(30 * time.Second), events: events}
	logCacheMu.Unlock()
	return events
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func computeAvailability(store *StateStore, nagiosLog, archivesDir string, from, to int64, target, hostgroup, hostFilter, serviceFilter string) (AvailabilitySummary, []AvailabilityRow, []TimelineBucket) {
	if to <= from {
		to = time.Now().Unix()
		from = to - 86400
	}
	if target != "hosts" {
		target = "services"
	}
	windowSec := float64(to - from)
	healthyState := "OK"
	defaultProblemState := "CRITICAL"
	if target == "hosts" {
		healthyState = "UP"
		defaultProblemState = "DOWN"
	}

	type objTrack struct {
		host            string
		service         string
		liveState       string
		hasBeenChecked  int
		lastStateChange int64
		preState        string // last known HARD state at or before `from`
		curState        string
		lastTS          int64
		inDowntime      bool
		events          []LogEvent // in-window events (from < ts <= to)
		okSec           float64
		warnSec         float64
		critSec         float64
		unkSec          float64
		dtSec           float64
		incidents       int
		critIncidents   int
		warnIncidents   int
		probStartTS     int64
		mttrSum         float64
		mttrCount       int
	}

	tracks := make(map[string]*objTrack)

	// Seed objects from live StateStore
	if target == "hosts" {
		hosts, _ := store.QueryHosts(QueryOpts{Hostgroup: hostgroup})
		for _, h := range hosts {
			if hostFilter != "" && h.Name != hostFilter {
				continue
			}
			st := "UP"
			if h.CurrentState == 1 {
				st = "DOWN"
			} else if h.CurrentState == 2 {
				st = "UNREACHABLE"
			}
			tracks[h.Name] = &objTrack{
				host: h.Name, liveState: st, hasBeenChecked: h.HasBeenChecked,
				lastStateChange: h.LastStateChange, lastTS: from,
			}
		}
	} else {
		svcs, _ := store.QueryServices(QueryOpts{Host: hostFilter, Hostgroup: hostgroup})
		for _, s := range svcs {
			if serviceFilter != "" && s.Description != serviceFilter {
				continue
			}
			st := "OK"
			switch s.CurrentState {
			case 1:
				st = "WARNING"
			case 2:
				st = "CRITICAL"
			case 3:
				st = "UNKNOWN"
			}
			k := svcKey(s.HostName, s.Description)
			tracks[k] = &objTrack{
				host: s.HostName, service: s.Description, liveState: st,
				hasBeenChecked: s.HasBeenChecked, lastStateChange: s.LastStateChange, lastTS: from,
			}
		}
	}

	// Prepare timeline buckets (hourly for <=48h, daily for >48h, capped cleanly)
	bucketSec := int64(3600)
	labelFmt := "15:04"
	if to-from > 48*3600 {
		bucketSec = 86400
		labelFmt = "01-02"
	}
	numBuckets := int((to - from + bucketSec - 1) / bucketSec)
	if numBuckets < 1 {
		numBuckets = 1
	}
	if numBuckets > 31 {
		bucketSec = (to - from + 29) / 30
		numBuckets = int((to - from + bucketSec - 1) / bucketSec)
	}
	bOK := make([]float64, numBuckets)
	bWarn := make([]float64, numBuckets)
	bCrit := make([]float64, numBuckets)
	bUnk := make([]float64, numBuckets)
	bTot := make([]float64, numBuckets)
	bInc := make([]int, numBuckets)
	bCritInc := make([]int, numBuckets)
	bWarnInc := make([]int, numBuckets)

	addDuration := func(tr *objTrack, until int64) {
		if until <= tr.lastTS {
			return
		}
		start := tr.lastTS
		dt := float64(until - start)
		if tr.inDowntime {
			tr.dtSec += dt
		}
		isOK := tr.curState == "UP" || tr.curState == "OK"
		isWarn := tr.curState == "WARNING" || tr.curState == "UNREACHABLE"
		isCrit := tr.curState == "DOWN" || tr.curState == "CRITICAL"
		switch tr.curState {
		case "UP", "OK":
			tr.okSec += dt
		case "WARNING":
			tr.warnSec += dt
		case "DOWN", "CRITICAL":
			tr.critSec += dt
		default:
			tr.unkSec += dt
		}
		// Distribute duration across timeline buckets
		bIdx := int((start - from) / bucketSec)
		if bIdx < 0 {
			bIdx = 0
		}
		cur := start
		for cur < until && bIdx < numBuckets {
			bEnd := from + int64(bIdx+1)*bucketSec
			if bEnd > until {
				bEnd = until
			}
			seg := float64(bEnd - cur)
			if seg > 0 {
				bTot[bIdx] += seg
				if isOK {
					bOK[bIdx] += seg
				} else if isWarn {
					bWarn[bIdx] += seg
				} else if isCrit {
					bCrit[bIdx] += seg
				} else {
					bUnk[bIdx] += seg
				}
			}
			cur = bEnd
			bIdx++
		}
		tr.lastTS = until
	}

	recordBucketInc := func(ts int64, state string) {
		idx := int((ts - from) / bucketSec)
		if idx >= 0 && idx < numBuckets {
			bInc[idx]++
			if state == "DOWN" || state == "CRITICAL" {
				bCritInc[idx]++
			} else {
				bWarnInc[idx]++
			}
		}
	}

	// Read log events with 24h lookback before `from` to establish exact starting state at `from`
	lookbackFrom := from - 86400
	events := readLogEvents(nagiosLog, archivesDir, lookbackFrom, to)
	logEventsUsed := 0
	for _, ev := range events {
		var tr *objTrack
		var ok bool
		if target == "hosts" {
			if ev.Type != "host_alert" && ev.Type != "host_state" && ev.Type != "downtime" {
				continue
			}
			if ev.Service != "" {
				continue
			}
			tr, ok = tracks[ev.Host]
		} else {
			if ev.Type != "service_alert" && ev.Type != "service_state" && ev.Type != "downtime" {
				continue
			}
			if ev.Service == "" {
				continue
			}
			tr, ok = tracks[svcKey(ev.Host, ev.Service)]
		}
		if !ok {
			continue
		}

		if ev.Timestamp <= from {
			if ev.Type == "downtime" {
				tr.inDowntime = ev.State == "STARTED"
			} else if ev.StateType == "HARD" && ev.State != "" {
				tr.preState = ev.State
			}
			continue
		}
		// Inside (from, to]
		if ev.Type == "host_state" || ev.Type == "service_state" {
			// Midnight/startup snapshot: only useful if we have no preState yet and no prior events
			if tr.preState == "" && len(tr.events) == 0 && ev.StateType == "HARD" && ev.State != "" {
				tr.preState = ev.State
			}
			continue
		}
		tr.events = append(tr.events, ev)
		logEventsUsed++
	}

	rows := make([]AvailabilityRow, 0, len(tracks))
	var slaSum, warnSum, critSum, unkSum, dtSum, probSecSum, mttrTotalSum float64
	var totalInc, totalCritInc, totalWarnInc, mttrTotalCnt int

	for _, tr := range tracks {
		// Determine accurate initial state at t = from
		hasHardEvent := false
		var firstHard LogEvent
		for _, ev := range tr.events {
			if ev.Type != "downtime" && ev.StateType == "HARD" {
				hasHardEvent = true
				firstHard = ev
				break
			}
		}

		if tr.preState != "" {
			tr.curState = tr.preState
		} else if hasHardEvent {
			// Infer pre-alert state from the first HARD transition inside the window
			if firstHard.State == healthyState {
				tr.curState = defaultProblemState
				tr.probStartTS = from
			} else {
				tr.curState = healthyState
			}
		} else {
			// No HARD alerts recorded in logs for this window: rely on live StateStore
			if tr.liveState != healthyState && tr.hasBeenChecked == 1 && tr.lastStateChange > from && tr.lastStateChange <= to {
				// Ongoing problem that started inside this window (e.g. log rotated or not yet flushed)
				tr.curState = healthyState
				addDuration(tr, tr.lastStateChange)
				tr.incidents++
				if tr.liveState == "DOWN" || tr.liveState == "CRITICAL" {
					tr.critIncidents++
				} else {
					tr.warnIncidents++
				}
				tr.probStartTS = tr.lastStateChange
				recordBucketInc(tr.lastStateChange, tr.liveState)
				tr.curState = tr.liveState
			} else {
				tr.curState = tr.liveState
			}
		}

		// Replay in-window events chronologically
		for _, ev := range tr.events {
			addDuration(tr, ev.Timestamp)
			if ev.Type == "downtime" {
				tr.inDowntime = ev.State == "STARTED"
				continue
			}
			if ev.StateType == "HARD" {
				wasHealthy := tr.curState == healthyState
				isHealthy := ev.State == healthyState
				if wasHealthy && !isHealthy {
					tr.incidents++
					if ev.State == "DOWN" || ev.State == "CRITICAL" {
						tr.critIncidents++
					} else {
						tr.warnIncidents++
					}
					tr.probStartTS = ev.Timestamp
					recordBucketInc(ev.Timestamp, ev.State)
				} else if !wasHealthy && isHealthy && tr.probStartTS > 0 {
					tr.mttrSum += float64(ev.Timestamp - tr.probStartTS)
					tr.mttrCount++
					tr.probStartTS = 0
				}
				tr.curState = ev.State
			}
		}

		addDuration(tr, to)
		okPct := round2((tr.okSec / windowSec) * 100.0)
		warnPct := round2((tr.warnSec / windowSec) * 100.0)
		critPct := round2((tr.critSec / windowSec) * 100.0)
		unkPct := round2((tr.unkSec / windowSec) * 100.0)
		dtPct := round2((tr.dtSec / windowSec) * 100.0)
		probSec := tr.warnSec + tr.critSec + tr.unkSec
		mttr := 0.0
		if tr.mttrCount > 0 {
			mttr = round2(tr.mttrSum / float64(tr.mttrCount))
			mttrTotalSum += tr.mttrSum
			mttrTotalCnt += tr.mttrCount
		}
		slaSum += okPct
		warnSum += warnPct
		critSum += critPct
		unkSum += unkPct
		dtSum += dtPct
		probSecSum += probSec
		totalInc += tr.incidents
		totalCritInc += tr.critIncidents
		totalWarnInc += tr.warnIncidents
		rows = append(rows, AvailabilityRow{
			Host:          tr.host,
			Service:       tr.service,
			OKPct:         okPct,
			WarnPct:       warnPct,
			CritPct:       critPct,
			UnkPct:        unkPct,
			DowntimePct:   dtPct,
			OKSec:         math.Round(tr.okSec),
			ProblemSec:    math.Round(probSec),
			Incidents:     tr.incidents,
			CritIncidents: tr.critIncidents,
			WarnIncidents: tr.warnIncidents,
			MTTRSec:       mttr,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].OKPct != rows[j].OKPct {
			return rows[i].OKPct < rows[j].OKPct // worst SLA first
		}
		if rows[i].Host != rows[j].Host {
			return rows[i].Host < rows[j].Host
		}
		return rows[i].Service < rows[j].Service
	})

	overallSLA := 100.0
	var avgWarn, avgCrit, avgUnk, avgDT float64
	if len(rows) > 0 {
		n := float64(len(rows))
		overallSLA = round2(slaSum / n)
		avgWarn = round2(warnSum / n)
		avgCrit = round2(critSum / n)
		avgUnk = round2(unkSum / n)
		avgDT = round2(dtSum / n)
	}
	avgMTTR := 0.0
	if mttrTotalCnt > 0 {
		avgMTTR = round2(mttrTotalSum / float64(mttrTotalCnt))
	}

	timeline := make([]TimelineBucket, numBuckets)
	for i := 0; i < numBuckets; i++ {
		ts := from + int64(i)*bucketSec
		pct, wp, cp, up := 100.0, 0.0, 0.0, 0.0
		if bTot[i] > 0 {
			pct = round2((bOK[i] / bTot[i]) * 100.0)
			wp = round2((bWarn[i] / bTot[i]) * 100.0)
			cp = round2((bCrit[i] / bTot[i]) * 100.0)
			up = round2((bUnk[i] / bTot[i]) * 100.0)
		}
		timeline[i] = TimelineBucket{
			Timestamp:     ts,
			Label:         time.Unix(ts, 0).Format(labelFmt),
			OKPct:         pct,
			WarnPct:       wp,
			CritPct:       cp,
			UnkPct:        up,
			Incidents:     bInc[i],
			CritIncidents: bCritInc[i],
			WarnIncidents: bWarnInc[i],
		}
	}

	return AvailabilitySummary{
		From:            from,
		To:              to,
		Target:          target,
		TotalObjects:    len(rows),
		OverallSLAPct:   overallSLA,
		WarnPct:         avgWarn,
		CritPct:         avgCrit,
		UnkPct:          avgUnk,
		DowntimePct:     avgDT,
		TotalProblemSec: math.Round(probSecSum),
		TotalIncidents:  totalInc,
		CritIncidents:   totalCritInc,
		WarnIncidents:   totalWarnInc,
		AvgMTTRSec:      avgMTTR,
		LogEventsUsed:   logEventsUsed,
	}, rows, timeline
}

func parseTimeRange(r *http.Request) (int64, int64) {
	now := time.Now().Unix()
	to, _ := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
	from, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	if to <= 0 {
		to = now
	}
	if from <= 0 || from >= to {
		from = to - 86400
	}
	return from, to
}

func registerReportRoutes(mux *http.ServeMux, store *StateStore, nagiosLog, archivesDir string) {
	mux.HandleFunc("/api/v1/reports/events", func(w http.ResponseWriter, r *http.Request) {
		from, to := parseTimeRange(r)
		q := r.URL.Query()
		evType := q.Get("type")
		host := q.Get("host")
		service := q.Get("service")
		state := strings.ToUpper(q.Get("state"))
		hardOnly := q.Get("hard_only") == "1" || q.Get("hard_only") == "true"
		search := strings.ToLower(q.Get("search"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		limit, _ := strconv.Atoi(q.Get("limit"))
		if offset < 0 {
			offset = 0
		}
		if limit <= 0 || limit > 500 {
			limit = 100
		}

		all := readLogEvents(nagiosLog, archivesDir, from, to)
		// Reverse chronological (newest first)
		filtered := make([]LogEvent, 0, len(all))
		for i := len(all) - 1; i >= 0; i-- {
			ev := all[i]
			if evType != "" && evType != "all" {
				if evType == "alerts" {
					if ev.Type != "host_alert" && ev.Type != "service_alert" && ev.Type != "notification" {
						continue
					}
				} else if ev.Type != evType {
					continue
				}
			}
			if host != "" && ev.Host != host {
				continue
			}
			if service != "" && ev.Service != service {
				continue
			}
			if state != "" && ev.State != state {
				continue
			}
			if hardOnly && ev.StateType != "" && ev.StateType != "HARD" {
				continue
			}
			if search != "" &&
				!strings.Contains(strings.ToLower(ev.Host), search) &&
				!strings.Contains(strings.ToLower(ev.Service), search) &&
				!strings.Contains(strings.ToLower(ev.Message), search) {
				continue
			}
			filtered = append(filtered, ev)
		}
		total := len(filtered)
		if offset >= total {
			writeJSON(w, http.StatusOK, map[string]any{"total": total, "events": []LogEvent{}})
			return
		}
		end := offset + limit
		if end > total {
			end = total
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"total":  total,
			"offset": offset,
			"count":  end - offset,
			"events": filtered[offset:end],
		})
	})

	mux.HandleFunc("/api/v1/reports/availability", func(w http.ResponseWriter, r *http.Request) {
		from, to := parseTimeRange(r)
		q := r.URL.Query()
		sum, rows, timeline := computeAvailability(store, nagiosLog, archivesDir, from, to, q.Get("target"), q.Get("hostgroup"), q.Get("host"), q.Get("service"))
		writeJSON(w, http.StatusOK, map[string]any{
			"summary":  sum,
			"rows":     rows,
			"timeline": timeline,
		})
	})

	mux.HandleFunc("/api/v1/reports/export", func(w http.ResponseWriter, r *http.Request) {
		from, to := parseTimeRange(r)
		q := r.URL.Query()
		format := strings.ToLower(q.Get("format"))
		if format == "" {
			format = "csv"
		}
		sum, rows, timeline := computeAvailability(store, nagiosLog, archivesDir, from, to, q.Get("target"), q.Get("hostgroup"), q.Get("host"), q.Get("service"))
		dateTag := time.Now().Format("20060102-1504")

		switch format {
		case "json":
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="encore-sla-%s.json"`, dateTag))
			writeJSON(w, http.StatusOK, map[string]any{"summary": sum, "rows": rows, "timeline": timeline})

		case "html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			var b strings.Builder
			fmt.Fprintf(&b, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Encore SLA Report</title><style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:28px;line-height:1.45}
h1{font-size:20px;margin:0 0 4px} .sub{color:#64748b;font-size:13px;margin-bottom:18px}
.kpis{display:flex;gap:14px;margin-bottom:18px} .kpi{flex:1;border:1px solid #e2e8f0;border-radius:8px;padding:12px}
.kpi .k{font-size:11px;text-transform:uppercase;color:#64748b;font-weight:700} .kpi .v{font-size:22px;font-weight:700}
table{width:100%%;border-collapse:collapse;font-size:12.5px} th,td{padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:left}
th{background:#f8fafc;font-size:11px;text-transform:uppercase;color:#64748b}
.no-print{margin-bottom:14px} @media print{.no-print{display:none}}
</style></head><body>
<div class="no-print"><button onclick="window.print()" style="padding:7px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600">Print / Save as PDF</button></div>
<h1>Encore Availability &amp; SLA Report (%s)</h1>
<div class="sub">Period: %s to %s • Generated %s</div>
<div class="kpis">
  <div class="kpi"><div class="k">Overall SLA</div><div class="v">%.2f%%</div></div>
  <div class="kpi"><div class="k">Objects</div><div class="v">%d</div></div>
  <div class="kpi"><div class="k">HARD Incidents</div><div class="v">%d</div></div>
  <div class="kpi"><div class="k">Avg MTTR</div><div class="v">%.1fs</div></div>
</div>
<table><thead><tr><th>Host</th><th>Service</th><th>UP/OK %%</th><th>WARN %%</th><th>CRIT/DOWN %%</th><th>Downtime %%</th><th>Incidents</th><th>MTTR (s)</th></tr></thead><tbody>`,
				html.EscapeString(sum.Target),
				time.Unix(sum.From, 0).Format("2006-01-02 15:04"),
				time.Unix(sum.To, 0).Format("2006-01-02 15:04"),
				time.Now().Format("2006-01-02 15:04"),
				sum.OverallSLAPct, sum.TotalObjects, sum.TotalIncidents, sum.AvgMTTRSec)
			for _, row := range rows {
				fmt.Fprintf(&b, "<tr><td><b>%s</b></td><td>%s</td><td>%.2f%%</td><td>%.2f%%</td><td>%.2f%%</td><td>%.2f%%</td><td>%d</td><td>%.1f</td></tr>",
					html.EscapeString(row.Host), html.EscapeString(row.Service),
					row.OKPct, row.WarnPct, row.CritPct, row.DowntimePct, row.Incidents, row.MTTRSec)
			}
			b.WriteString("</tbody></table></body></html>")
			_, _ = w.Write([]byte(b.String()))

		default: // csv
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="encore-sla-%s.csv"`, dateTag))
			cw := csv.NewWriter(w)
			_ = cw.Write([]string{"host", "service", "ok_pct", "warn_pct", "crit_pct", "unk_pct", "downtime_pct", "incidents", "mttr_sec"})
			for _, row := range rows {
				_ = cw.Write([]string{
					row.Host, row.Service,
					fmt.Sprintf("%.2f", row.OKPct),
					fmt.Sprintf("%.2f", row.WarnPct),
					fmt.Sprintf("%.2f", row.CritPct),
					fmt.Sprintf("%.2f", row.UnkPct),
					fmt.Sprintf("%.2f", row.DowntimePct),
					strconv.Itoa(row.Incidents),
					fmt.Sprintf("%.1f", row.MTTRSec),
				})
			}
			cw.Flush()
		}
	})
}
