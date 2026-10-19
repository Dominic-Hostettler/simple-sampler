package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed static
var static embed.FS

const (
	maxMessageSize = maxTrackSize + 1<<10 // a whole track plus the message around it
	maxRooms       = 50
	roomTTL        = 10 * time.Minute // empty rooms are deleted after this

	// Per client IP, so one client can't take all rooms. Behind a reverse proxy
	// every client has the proxy's IP, so these then apply to everyone together.
	maxConnsPerIP = 32
	maxRoomsPerIP = 10

	// Messages per connection: msgRate per second, bursts up to msgBurst.
	// A knob drag sends 20/s, the BPM slider 10/s.
	msgRate  = 50
	msgBurst = 100
)

var (
	validRoom = regexp.MustCompile(`^[a-z0-9]{4,32}$`)
	validUser = regexp.MustCompile(`^[a-f0-9]{32}$`)
)

type inbound struct {
	Type  string          `json:"type"`
	Key   string          `json:"key"`
	Field string          `json:"field"`
	Value json.RawMessage `json:"value"`
	Track int             `json:"track"`
	T     float64         `json:"t"`
}

type server struct {
	mu    sync.Mutex
	rooms map[string]*room
	conns map[string]int // open connections per IP
	files fs.FS
}

// limiter is a token bucket: it allows rate events per second, bursts up to burst.
type limiter struct {
	rate, burst, tokens float64
	last                time.Time
}

func newLimiter(rate, burst float64) *limiter {
	return &limiter{rate: rate, burst: burst, tokens: burst, last: time.Now()}
}

func (l *limiter) allow() bool {
	now := time.Now()
	l.tokens = min(l.burst, l.tokens+now.Sub(l.last).Seconds()*l.rate)
	l.last = now
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// roomsOf counts the rooms created by the IP. Called with srv.mu held.
func (srv *server) roomsOf(ip string) int {
	n := 0
	for _, rm := range srv.rooms {
		if rm.creator == ip {
			n++
		}
	}
	return n
}

func serverNow() float64 {
	return float64(time.Now().UnixMicro()) / 1000
}

func newRoomID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

func (srv *server) newRoom(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/r/"+newRoomID(), http.StatusFound)
}

func (srv *server) servePage(w http.ResponseWriter, r *http.Request) {
	if !validRoom.MatchString(r.PathValue("room")) {
		http.NotFound(w, r)
		return
	}
	http.ServeFileFS(w, r, srv.files, "index.html")
}

func (srv *server) serveWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("room")
	user := r.URL.Query().Get("user")
	if !validRoom.MatchString(id) || !validUser.MatchString(user) {
		http.Error(w, "invalid room or user", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(maxMessageSize)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &client{user: user, send: make(chan []byte, 64), kick: cancel}

	ip := clientIP(r)
	srv.mu.Lock()
	rm := srv.rooms[id]
	reject := ""
	switch {
	case srv.conns[ip] >= maxConnsPerIP:
		reject = "too many connections"
	case rm == nil && (len(srv.rooms) >= maxRooms || srv.roomsOf(ip) >= maxRoomsPerIP):
		reject = "too many rooms"
	case rm != nil && len(rm.clients) >= maxClients:
		reject = "room is full"
	}
	if reject != "" {
		srv.mu.Unlock()
		conn.Close(websocket.StatusTryAgainLater, reject)
		return
	}
	if rm == nil {
		rm = newRoom(&srv.mu, ip)
		srv.rooms[id] = rm
	}
	srv.conns[ip]++
	rm.join(c)
	srv.mu.Unlock()

	defer func() {
		srv.mu.Lock()
		rm.leave(c)
		if srv.conns[ip]--; srv.conns[ip] == 0 {
			delete(srv.conns, ip)
		}
		srv.mu.Unlock()
	}()

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-c.send:
				wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(wctx, websocket.MessageText, msg)
				wcancel()
				if err != nil {
					return
				}
			}
		}
	}()

	limit := newLimiter(msgRate, msgBurst)
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if !limit.allow() {
			conn.Close(websocket.StatusPolicyViolation, "too many messages")
			return
		}
		var m inbound
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m.Type == "ping" {
			pong, _ := json.Marshal(outbound{Type: "pong", T: m.T, Server: serverNow()})
			enqueue(c, pong)
			continue
		}
		srv.mu.Lock()
		switch m.Type {
		case "set":
			// A write without a value would look like a deletion to the clients
			if len(m.Value) > 0 {
				rm.set(c, m.Key, m.Field, m.Value)
			}
		case "add":
			if len(m.Value) > 0 {
				rm.add(m.Value)
			}
		case "remove":
			rm.remove(user, m.Track)
		case "seed":
			var values []json.RawMessage
			if json.Unmarshal(m.Value, &values) == nil {
				rm.seed(values)
			}
		case "claim":
			rm.claim(user, m.Track)
		case "release":
			rm.release(user, m.Track)
		}
		srv.mu.Unlock()
	}
}

// cleanup deletes rooms that have been empty for roomTTL.
func (srv *server) cleanup() {
	for range time.Tick(time.Minute) {
		srv.mu.Lock()
		for id, rm := range srv.rooms {
			if len(rm.clients) == 0 && time.Since(rm.lastActive) > roomTTL {
				delete(srv.rooms, id)
			}
		}
		srv.mu.Unlock()
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
	}

	// DEV=1 serves the frontend from disk, so edits show up on a browser refresh
	dev := os.Getenv("DEV") != ""
	var files fs.FS = os.DirFS("static")
	if !dev {
		var err error
		if files, err = fs.Sub(static, "static"); err != nil {
			log.Fatal(err)
		}
	}

	srv := &server{rooms: make(map[string]*room), conns: make(map[string]int), files: files}
	go srv.cleanup()

	http.HandleFunc("GET /{$}", srv.newRoom)
	http.HandleFunc("GET /r/{room}", srv.servePage)
	http.HandleFunc("GET /ws/{room}", srv.serveWS)
	http.Handle("GET /", http.FileServerFS(files))

	var handler http.Handler = http.DefaultServeMux
	if dev {
		handler = noCache(handler)
		log.Print("dev mode: serving static/ from disk")
	}

	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, handler))
}

// noCache makes the browser revalidate every file, so a refresh always loads
// the latest edits.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}
