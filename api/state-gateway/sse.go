package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type SSEEvent struct {
	Kind      string `json:"kind"` // "host" or "service"
	Host      string `json:"host"`
	Service   string `json:"service,omitempty"`
	State     int    `json:"state"`
	PrevState int    `json:"prev_state"`
	StateType int    `json:"state_type"` // 0=SOFT, 1=HARD
	Output    string `json:"output,omitempty"`
	TS        int64  `json:"ts"`
}

type EventBroker struct {
	mu      sync.RWMutex
	clients map[chan []byte]struct{}
}

func NewEventBroker() *EventBroker {
	return &EventBroker{
		clients: make(map[chan []byte]struct{}),
	}
}

func (b *EventBroker) Subscribe() chan []byte {
	ch := make(chan []byte, 32)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *EventBroker) Unsubscribe(ch chan []byte) {
	b.mu.Lock()
	if _, ok := b.clients[ch]; ok {
		delete(b.clients, ch)
		close(ch)
	}
	b.mu.Unlock()
}

func (b *EventBroker) Publish(ev SSEEvent) {
	if b == nil {
		return
	}
	b.mu.RLock()
	if len(b.clients) == 0 {
		b.mu.RUnlock()
		return
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		b.mu.RUnlock()
		return
	}
	for ch := range b.clients {
		select {
		case ch <- raw:
		default:
			// Drop on slow consumer so event ingestion never blocks
		}
	}
	b.mu.RUnlock()
}

func (b *EventBroker) ClientCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.clients)
}

func registerSSERoutes(mux *http.ServeMux, broker *EventBroker) {
	mux.HandleFunc("/api/v1/stream", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-store")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // Disable nginx proxy buffering
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, "event: ready\ndata: {\"status\":\"connected\"}\n\n")
		flusher.Flush()

		ch := broker.Subscribe()
		defer broker.Unsubscribe(ch)

		heartbeat := time.NewTicker(25 * time.Second)
		defer heartbeat.Stop()

		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				return
			case <-heartbeat.C:
				_, _ = fmt.Fprint(w, ": ping\n\n")
				flusher.Flush()
			case payload, ok := <-ch:
				if !ok {
					return
				}
				_, _ = fmt.Fprintf(w, "event: state\ndata: %s\n\n", payload)
				flusher.Flush()
			}
		}
	})
}
