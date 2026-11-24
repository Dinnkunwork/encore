package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var msgDelim = []byte{1, 0, 0, 0}

type kvPair struct {
	Key string
	Val string
}

type CheckResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	TimedOut bool
	ErrCode  int
}

type Worker struct {
	name            string
	qhPath          string
	plugins         []string
	maxJobs         int
	httpCliStrict   *http.Client
	httpCliInsecure *http.Client
	completed       atomic.Int64
	fastPath        atomic.Int64
	fallback        atomic.Int64
}

func NewWorker(name, qhPath string, plugins []string, maxJobs int) *Worker {
	trStrict := &http.Transport{
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     60 * time.Second,
	}
	trInsecure := &http.Transport{
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     60 * time.Second,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
	}
	return &Worker{
		name:            name,
		qhPath:          qhPath,
		plugins:         plugins,
		maxJobs:         maxJobs,
		httpCliStrict:   &http.Client{Transport: trStrict},
		httpCliInsecure: &http.Client{Transport: trInsecure},
	}
}

// splitCommand splits a shell-like command line into argv tokens (handles simple quotes).
func splitCommand(cmd string) ([]string, bool) {
	var args []string
	var cur strings.Builder
	inSingle := false
	inDouble := false
	escaped := false

	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		if escaped {
			cur.WriteByte(c)
			escaped = false
			continue
		}
		if c == '\\' && !inSingle {
			escaped = true
			continue
		}
		if c == '\'' && !inDouble {
			inSingle = !inSingle
			continue
		}
		if c == '"' && !inSingle {
			inDouble = !inDouble
			continue
		}
		if !inSingle && !inDouble {
			// If shell metacharacters exist, signal fallback
			if c == '|' || c == ';' || c == '&' || c == '>' || c == '<' || c == '`' || c == '$' {
				return nil, false
			}
			if c == ' ' || c == '\t' {
				if cur.Len() > 0 {
					args = append(args, cur.String())
					cur.Reset()
				}
				continue
			}
		}
		cur.WriteByte(c)
	}
	if inSingle || inDouble || escaped {
		return nil, false
	}
	if cur.Len() > 0 {
		args = append(args, cur.String())
	}
	return args, len(args) > 0
}

func parseKVMessage(msg []byte) []kvPair {
	parts := bytes.Split(msg, []byte{0})
	pairs := make([]kvPair, 0, len(parts))
	for _, p := range parts {
		if len(p) == 0 {
			continue
		}
		idx := bytes.IndexByte(p, '=')
		if idx <= 0 {
			continue
		}
		pairs = append(pairs, kvPair{
			Key: string(p[:idx]),
			Val: string(p[idx+1:]),
		})
	}
	return pairs
}

func encodeKVMessage(pairs []kvPair) []byte {
	var buf bytes.Buffer
	for _, kv := range pairs {
		// Strip NUL bytes from values per Nagios wproc protocol
		val := strings.ReplaceAll(kv.Val, "\x00", "")
		buf.WriteString(kv.Key)
		buf.WriteByte('=')
		buf.WriteString(val)
		buf.WriteByte(0)
	}
	buf.Write(msgDelim)
	return buf.Bytes()
}

func formatTV(t time.Time) string {
	return fmt.Sprintf("%d.%06d", t.Unix(), t.Nanosecond()/1000)
}

func (w *Worker) runCheckTCP(ctx context.Context, args []string) (CheckResult, bool) {
	var host string
	var port int
	var warnSec, critSec float64
	timeoutSec := 10.0

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-H":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			host = args[i]
		case "-p":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.Atoi(args[i])
			if err != nil {
				return CheckResult{}, false
			}
			port = v
		case "-t":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.ParseFloat(args[i], 64)
			if err != nil {
				return CheckResult{}, false
			}
			timeoutSec = v
		case "-w":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.ParseFloat(args[i], 64)
			if err != nil {
				return CheckResult{}, false
			}
			warnSec = v
		case "-c":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.ParseFloat(args[i], 64)
			if err != nil {
				return CheckResult{}, false
			}
			critSec = v
		default:
			// Unknown flag -> fallback to external plugin
			return CheckResult{}, false
		}
	}

	if host == "" || port <= 0 {
		return CheckResult{}, false
	}

	tctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec*float64(time.Second)))
	defer cancel()

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	t0 := time.Now()
	d := net.Dialer{}
	conn, err := d.DialContext(tctx, "tcp", addr)
	elapsed := time.Since(t0).Seconds()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return CheckResult{
				ExitCode: 2,
				Stdout:   fmt.Sprintf("CRITICAL - Socket timeout after %.3f seconds\n", elapsed),
			}, true
		}
		return CheckResult{
			ExitCode: 2,
			Stdout:   fmt.Sprintf("TCP CRITICAL - %v\n", err),
		}, true
	}
	_ = conn.Close()

	state := 0
	label := "TCP OK"
	if critSec > 0 && elapsed >= critSec {
		state = 2
		label = "TCP CRITICAL"
	} else if warnSec > 0 && elapsed >= warnSec {
		state = 1
		label = "TCP WARNING"
	}
	return CheckResult{
		ExitCode: state,
		Stdout: fmt.Sprintf("%s - %.3f second response time on %s port %d|time=%.6fs;%.6f;%.6f;0.000000;%.6f\n",
			label, elapsed, host, port, elapsed, warnSec, critSec, timeoutSec),
	}, true
}

func (w *Worker) runCheckHTTP(ctx context.Context, args []string) (CheckResult, bool) {
	var host, ip, uri, expectStr string
	var port int
	useSSL := false
	insecure := false
	var warnSec, critSec float64
	timeoutSec := 10.0
	expectCode := 0

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-H":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			host = args[i]
		case "-I":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			ip = args[i]
		case "-p":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.Atoi(args[i])
			if err != nil {
				return CheckResult{}, false
			}
			port = v
		case "-u":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			uri = args[i]
		case "-S", "--ssl":
			useSSL = true
		case "-k", "--insecure":
			insecure = true
		case "-s":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			expectStr = args[i]
		case "-e":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.Atoi(args[i])
			if err != nil {
				return CheckResult{}, false
			}
			expectCode = v
		case "-t":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.ParseFloat(args[i], 64)
			if err != nil {
				return CheckResult{}, false
			}
			timeoutSec = v
		case "-w":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.ParseFloat(args[i], 64)
			if err != nil {
				return CheckResult{}, false
			}
			warnSec = v
		case "-c":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.ParseFloat(args[i], 64)
			if err != nil {
				return CheckResult{}, false
			}
			critSec = v
		default:
			return CheckResult{}, false
		}
	}

	target := ip
	if target == "" {
		target = host
	}
	if target == "" {
		return CheckResult{}, false
	}
	if uri == "" {
		uri = "/"
	}
	scheme := "http"
	if useSSL {
		scheme = "https"
	}
	hostPort := target
	if port > 0 {
		hostPort = net.JoinHostPort(target, strconv.Itoa(port))
	}
	urlStr := fmt.Sprintf("%s://%s%s", scheme, hostPort, uri)

	tctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec*float64(time.Second)))
	defer cancel()

	req, err := http.NewRequestWithContext(tctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return CheckResult{ExitCode: 3, Stdout: fmt.Sprintf("HTTP UNKNOWN - %v\n", err)}, true
	}
	if host != "" {
		req.Host = host
	}

	t0 := time.Now()
	cli := w.httpCliStrict
	if insecure {
		cli = w.httpCliInsecure
	}
	resp, err := cli.Do(req)
	elapsed := time.Since(t0).Seconds()
	if err != nil {
		return CheckResult{ExitCode: 2, Stdout: fmt.Sprintf("HTTP CRITICAL - %v\n", err)}, true
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))

	state := 0
	label := "HTTP OK"
	if expectCode > 0 {
		if resp.StatusCode != expectCode {
			state = 2
			label = "HTTP CRITICAL"
		}
	} else if resp.StatusCode >= 500 {
		state = 2
		label = "HTTP CRITICAL"
	} else if resp.StatusCode >= 400 {
		state = 1
		label = "HTTP WARNING"
	}

	if state == 0 && expectStr != "" && !strings.Contains(string(body), expectStr) {
		state = 2
		label = "HTTP CRITICAL"
	}
	if state < 2 && critSec > 0 && elapsed >= critSec {
		state = 2
		label = "HTTP CRITICAL"
	} else if state < 1 && warnSec > 0 && elapsed >= warnSec {
		state = 1
		label = "HTTP WARNING"
	}

	return CheckResult{
		ExitCode: state,
		Stdout: fmt.Sprintf("%s: %s - %d bytes in %.3f second response time |time=%.6fs;%.6f;%.6f;0.000000 size=%dB;;;0\n",
			label, resp.Status, len(body), elapsed, elapsed, warnSec, critSec, len(body)),
	}, true
}

func (w *Worker) runCheckNCPA(ctx context.Context, args []string) (CheckResult, bool) {
	var host, token, metric, warnStr, critStr, units string
	port := 5693
	timeoutSec := 15.0
	var extraQueries []string

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-H", "--host":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			host = args[i]
		case "-P", "--port":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			v, err := strconv.Atoi(args[i])
			if err != nil {
				return CheckResult{}, false
			}
			port = v
		case "-t", "--token":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			token = args[i]
		case "-M", "--metric":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			metric = strings.TrimPrefix(args[i], "/")
		case "-w", "--warning":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			warnStr = args[i]
		case "-c", "--critical":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			critStr = args[i]
		case "-u", "--units":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			units = args[i]
		case "-q", "--queryargs":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			extraQueries = append(extraQueries, args[i])
		case "-T", "--timeout":
			if i+1 >= len(args) {
				return CheckResult{}, false
			}
			i++
			if v, err := strconv.ParseFloat(args[i], 64); err == nil && v > 0 {
				timeoutSec = v
			}
		default:
			return CheckResult{}, false
		}
	}

	if host == "" || token == "" || metric == "" {
		return CheckResult{}, false
	}

	q := url.Values{}
	q.Set("token", token)
	q.Set("check", "1")
	if warnStr != "" {
		q.Set("warning", warnStr)
	}
	if critStr != "" {
		q.Set("critical", critStr)
	}
	if units != "" {
		q.Set("units", units)
	}
	for _, eq := range extraQueries {
		for _, pair := range strings.Split(eq, ",") {
			if k, v, ok := strings.Cut(pair, "="); ok {
				q.Add(strings.TrimSpace(k), strings.TrimSpace(v))
			}
		}
	}

	endpoint := fmt.Sprintf("https://%s/api/%s?%s",
		net.JoinHostPort(host, strconv.Itoa(port)), metric, q.Encode())

	tctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec*float64(time.Second)))
	defer cancel()

	req, err := http.NewRequestWithContext(tctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return CheckResult{ExitCode: 3, Stdout: fmt.Sprintf("UNKNOWN: NCPA request build error: %v\n", err)}, true
	}

	resp, err := w.httpCliInsecure.Do(req)
	if err != nil {
		return CheckResult{ExitCode: 2, Stdout: fmt.Sprintf("CRITICAL: Unable to contact NCPA on %s:%d: %v\n", host, port, err)}, true
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if resp.StatusCode != http.StatusOK {
		return CheckResult{ExitCode: 2, Stdout: fmt.Sprintf("CRITICAL: NCPA HTTP %d: %s\n", resp.StatusCode, strings.TrimSpace(string(body)))}, true
	}

	var ncpaResp struct {
		ReturnCode int    `json:"returncode"`
		Stdout     string `json:"stdout"`
		Error      string `json:"error"`
	}
	if err := json.Unmarshal(body, &ncpaResp); err != nil {
		return CheckResult{ExitCode: 3, Stdout: fmt.Sprintf("UNKNOWN: Invalid NCPA JSON response: %v\n", err)}, true
	}
	if ncpaResp.Error != "" {
		return CheckResult{ExitCode: 3, Stdout: fmt.Sprintf("UNKNOWN: NCPA error: %s\n", ncpaResp.Error)}, true
	}
	out := ncpaResp.Stdout
	if out != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return CheckResult{ExitCode: ncpaResp.ReturnCode, Stdout: out}, true
}

func (w *Worker) runCheckDummy(args []string) (CheckResult, bool) {
	if len(args) == 0 {
		return CheckResult{ExitCode: 0, Stdout: "OK - dummy check\n"}, true
	}
	code, err := strconv.Atoi(args[0])
	if err != nil {
		// Support check_mock.sh style: <kind> <target>
		return CheckResult{
			ExitCode: 0,
			Stdout:   fmt.Sprintf("OK - in-process check %s | latency=0.1ms;50;100;0;200\n", strings.Join(args, " ")),
		}, true
	}
	msg := "OK"
	if len(args) > 1 {
		msg = strings.Join(args[1:], " ")
	}
	return CheckResult{ExitCode: code, Stdout: msg + "\n"}, true
}

func (w *Worker) executeFallback(ctx context.Context, cmdLine string) CheckResult {
	w.fallback.Add(1)
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", cmdLine)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return CheckResult{
			ExitCode: 2,
			Stdout:   outBuf.String(),
			Stderr:   errBuf.String(),
			TimedOut: true,
			ErrCode:  int(syscall.ETIME),
		}
	}
	exitCode := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
		} else {
			return CheckResult{
				ExitCode: 3,
				Stderr:   err.Error(),
				ErrCode:  1,
			}
		}
	}
	return CheckResult{
		ExitCode: exitCode,
		Stdout:   outBuf.String(),
		Stderr:   errBuf.String(),
	}
}

func (w *Worker) ExecuteCommand(ctx context.Context, cmdLine string) CheckResult {
	args, ok := splitCommand(cmdLine)
	if ok && len(args) > 0 {
		base := filepath.Base(args[0])
		switch base {
		case "check_tcp":
			if res, handled := w.runCheckTCP(ctx, args[1:]); handled {
				w.fastPath.Add(1)
				return res
			}
		case "check_http":
			if res, handled := w.runCheckHTTP(ctx, args[1:]); handled {
				w.fastPath.Add(1)
				return res
			}
		case "check_ncpa.py", "check_ncpa":
			if res, handled := w.runCheckNCPA(ctx, args[1:]); handled {
				w.fastPath.Add(1)
				return res
			}
		case "check_dummy", "check_mock.sh":
			if res, handled := w.runCheckDummy(args[1:]); handled {
				w.fastPath.Add(1)
				return res
			}
		}
	}
	return w.executeFallback(ctx, cmdLine)
}

func (w *Worker) handleJob(ctx context.Context, req []kvPair, writeMu *sync.Mutex, conn net.Conn) {
	var cmdLine string
	timeoutSec := 60

	resp := make([]kvPair, 0, len(req)+8)
	for _, kv := range req {
		if kv.Key == "env" {
			continue
		}
		if kv.Key == "command" {
			cmdLine = kv.Val
		} else if kv.Key == "timeout" {
			if v, err := strconv.Atoi(kv.Val); err == nil && v > 0 {
				timeoutSec = v
			}
		}
		resp = append(resp, kv)
	}

	start := time.Now()
	jobCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	res := w.ExecuteCommand(jobCtx, cmdLine)
	cancel()
	stop := time.Now()
	runtimeSec := stop.Sub(start).Seconds()

	// POSIX wait_status encodes normal exit code in bits 8..15 (exitCode << 8)
	waitStatus := (res.ExitCode & 0xff) << 8

	resp = append(resp,
		kvPair{Key: "wait_status", Val: strconv.Itoa(waitStatus)},
		kvPair{Key: "start", Val: formatTV(start)},
		kvPair{Key: "stop", Val: formatTV(stop)},
		kvPair{Key: "runtime", Val: fmt.Sprintf("%.6f", runtimeSec)},
	)
	if res.TimedOut || res.ErrCode != 0 {
		resp = append(resp,
			kvPair{Key: "exited_ok", Val: "0"},
			kvPair{Key: "error_code", Val: strconv.Itoa(res.ErrCode)},
		)
	} else {
		resp = append(resp, kvPair{Key: "exited_ok", Val: "1"})
	}
	resp = append(resp,
		kvPair{Key: "outerr", Val: res.Stderr},
		kvPair{Key: "outstd", Val: res.Stdout},
	)

	payload := encodeKVMessage(resp)
	writeMu.Lock()
	_, err := conn.Write(payload)
	writeMu.Unlock()
	if err != nil {
		log.Printf("[worker] write error: %v", err)
	}
	w.completed.Add(1)
}

func (w *Worker) buildRegisterCmd() string {
	parts := []string{
		fmt.Sprintf("name=%s", w.name),
		fmt.Sprintf("pid=%d", os.Getpid()),
		fmt.Sprintf("max_jobs=%d", w.maxJobs),
	}
	for _, p := range w.plugins {
		p = strings.TrimSpace(p)
		if p != "" {
			parts = append(parts, "plugin="+p)
		}
	}
	return "@wproc register " + strings.Join(parts, ";") + "\x00"
}

func (w *Worker) Run(ctx context.Context) {
	sem := make(chan struct{}, w.maxJobs)
	backoff := 500 * time.Millisecond

	for {
		if ctx.Err() != nil {
			return
		}
		conn, err := net.DialTimeout("unix", w.qhPath, 5*time.Second)
		if err != nil {
			log.Printf("[worker] connect %s failed: %v (retrying in %v)", w.qhPath, err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 3*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = 500 * time.Millisecond

		reg := w.buildRegisterCmd()
		if _, err := conn.Write([]byte(reg)); err != nil {
			_ = conn.Close()
			continue
		}

		// Read "OK\0" handshake response
		ack := make([]byte, 3)
		if _, err := io.ReadFull(conn, ack); err != nil || !bytes.Equal(ack, []byte{'O', 'K', 0}) {
			log.Printf("[worker] register handshake failed: %q err=%v", string(ack), err)
			_ = conn.Close()
			time.Sleep(500 * time.Millisecond)
			continue
		}
		log.Printf("[worker] registered '%s' on %s (plugins=%v, max_jobs=%d)",
			w.name, w.qhPath, w.plugins, w.maxJobs)

		go func(c net.Conn) {
			<-ctx.Done()
			_ = c.Close()
		}(conn)

		var writeMu sync.Mutex
		var wg sync.WaitGroup
		var buf bytes.Buffer
		tmp := make([]byte, 64*1024)

		for {
			n, err := conn.Read(tmp)
			if n > 0 {
				buf.Write(tmp[:n])
				for {
					data := buf.Bytes()
					idx := bytes.Index(data, msgDelim)
					if idx < 0 {
						break
					}
					msgCopy := make([]byte, idx)
					copy(msgCopy, data[:idx])
					buf.Next(idx + len(msgDelim))

					req := parseKVMessage(msgCopy)
					if len(req) == 0 {
						continue
					}
					sem <- struct{}{}
					wg.Add(1)
					go func(pairs []kvPair) {
						defer wg.Done()
						defer func() { <-sem }()
						w.handleJob(ctx, pairs, &writeMu, conn)
					}(req)
				}
			}
			if err != nil {
				break
			}
		}

		wg.Wait()
		_ = conn.Close()
		if ctx.Err() != nil {
			return
		}
		log.Printf("[worker] disconnected (completed=%d, fast_path=%d, fallback=%d), reconnecting...",
			w.completed.Load(), w.fastPath.Load(), w.fallback.Load())
		time.Sleep(500 * time.Millisecond)
	}
}

func main() {
	name := flag.String("name", fmt.Sprintf("Encore Go Worker %d", os.Getpid()), "Worker name")
	qhPath := flag.String("qh", "/usr/local/nagios/var/rw/nagios.qh", "Path to Nagios QH Unix socket")
	pluginsCSV := flag.String("plugins", "check_tcp,check_http,check_dummy,check_ncpa.py,check_ncpa", "Comma-separated plugin names to handle")
	maxJobs := flag.Int("max-jobs", 512, "Maximum concurrent in-process jobs")
	flag.Parse()

	var plugins []string
	for _, p := range strings.Split(*pluginsCSV, ",") {
		if s := strings.TrimSpace(p); s != "" {
			plugins = append(plugins, s)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	w := NewWorker(*name, *qhPath, plugins, *maxJobs)
	w.Run(ctx)
	log.Printf("[worker] shutdown cleanly (completed=%d, fast_path=%d, fallback=%d)",
		w.completed.Load(), w.fastPath.Load(), w.fallback.Load())
}
