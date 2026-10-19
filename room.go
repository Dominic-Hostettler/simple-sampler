package main

import (
	"context"
	"encoding/json"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxTracks    = 8
	maxFields    = 16               // per track
	maxTrackSize = 64 << 10         // bytes of all fields of a track together
	maxClients   = 16               // per room
	claimGrace   = 10 * time.Second // keeps a track claimed across a page refresh
)

var validField = regexp.MustCompile(`^[a-zA-Z]{1,32}$`)

type outbound struct {
	Type   string                     `json:"type"`
	Key    string                     `json:"key,omitempty"`
	Field  string                     `json:"field,omitempty"`
	Value  json.RawMessage            `json:"value,omitempty"`
	State  map[string]json.RawMessage `json:"state,omitempty"`
	Own    bool                       `json:"own,omitempty"` // reply to the receiver's own write
	T      float64                    `json:"t,omitempty"`
	Server float64                    `json:"server,omitempty"`
}

type client struct {
	user string
	send chan []byte
	kick context.CancelFunc
}

type track struct {
	owner  string                     // "" if free
	fields map[string]json.RawMessage // e.g. steps, params; values aren't interpreted
}

func (t *track) size() int {
	n := 0
	for _, v := range t.fields {
		n += len(v)
	}
	return n
}

// room is the state shared by its clients: the transport and the tracks. The
// server doesn't interpret the values; it only orders writes, relays them and
// enforces track ownership. Track n is sent as "track.n", a write changes one
// field of it, so edits of different fields don't overwrite each other.
type room struct {
	mu         *sync.Mutex // the server's lock, shared by all rooms
	transport  json.RawMessage
	tracks     map[int]*track
	clients    map[*client]struct{}
	conns      map[string]int // open connections per user
	nextTrack  int            // ID of the next added track; IDs are never reused
	seeded     bool           // the room got its first tracks; an emptied room stays empty
	creator    string         // IP that created the room, for the per-IP limit
	lastActive time.Time
}

func newRoom(mu *sync.Mutex, creator string) *room {
	return &room{
		mu:         mu,
		tracks:     make(map[int]*track),
		clients:    make(map[*client]struct{}),
		conns:      make(map[string]int),
		creator:    creator,
		lastActive: time.Now(),
	}
}

func trackKey(n int) string { return "track." + strconv.Itoa(n) }

// trackID parses a track key. Only the canonical form counts, so "track.01"
// can't become a second key for track 1.
func trackID(key string) (int, bool) {
	rest, ok := strings.CutPrefix(key, "track.")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(rest)
	return n, err == nil && strconv.Itoa(n) == rest
}

// All room methods are called with rm.mu held.

func (rm *room) trackValue(n int) json.RawMessage {
	out, _ := json.Marshal(rm.tracks[n].fields)
	return out
}

func (rm *room) join(c *client) {
	rm.clients[c] = struct{}{}
	rm.conns[c.user]++

	// Everyone gets an instrument while one is free
	claimed := rm.claimFree(c.user)

	snapshot := make(map[string]json.RawMessage, len(rm.tracks)+2)
	if rm.transport != nil {
		snapshot["transport"] = rm.transport
	}
	for n := range rm.tracks {
		snapshot[trackKey(n)] = rm.trackValue(n)
	}
	snapshot["owners"] = rm.ownersFor(c.user)
	msg, _ := json.Marshal(outbound{Type: "state", State: snapshot})
	enqueue(c, msg)

	if claimed {
		rm.broadcastOwners()
	}
}

func (rm *room) leave(c *client) {
	delete(rm.clients, c)
	rm.lastActive = time.Now()
	rm.conns[c.user]--
	if rm.conns[c.user] > 0 {
		return
	}
	delete(rm.conns, c.user)
	time.AfterFunc(claimGrace, func() {
		rm.mu.Lock()
		defer rm.mu.Unlock()
		if rm.conns[c.user] > 0 {
			return
		}
		if n := rm.trackOf(c.user); n >= 0 {
			rm.tracks[n].owner = ""
			rm.broadcastOwners()
		}
	})
}

// set stores a write to the transport (without field) or to one field of a
// track, and broadcasts it to every client, including the sender, so all
// clients apply writes in the same order. The sender gets exactly one reply
// marked as its own: the echo, or the current value if the write was
// rejected, which undoes its optimistic change. Other keys are ignored.
func (rm *room) set(c *client, key, field string, value json.RawMessage) {
	if key == "transport" && field == "" {
		rm.transport = value
		rm.broadcast(c, key, "", value)
		return
	}
	n, ok := trackID(key)
	if !ok {
		return
	}
	t := rm.tracks[n]
	if t == nil {
		// The track was removed; a reply without value removes it on the client too
		rm.reply(c, key, "", nil)
		return
	}
	old, exists := t.fields[field]
	if !validField.MatchString(field) || !rm.canEdit(c.user, n) ||
		(!exists && len(t.fields) >= maxFields) || t.size()-len(old)+len(value) > maxTrackSize {
		rm.reply(c, key, field, old)
		return
	}
	t.fields[field] = value
	rm.broadcast(c, key, field, value)
}

func (rm *room) reply(c *client, key, field string, value json.RawMessage) {
	msg, _ := json.Marshal(outbound{Type: "set", Key: key, Field: field, Value: value, Own: true})
	enqueue(c, msg)
}

// broadcast sends a write to every client; from, if not nil, gets it marked
// as its own. Without field the value is a whole track (or the transport), and
// a missing value means the track was removed.
func (rm *room) broadcast(from *client, key, field string, value json.RawMessage) {
	msg, _ := json.Marshal(outbound{Type: "set", Key: key, Field: field, Value: value})
	own, _ := json.Marshal(outbound{Type: "set", Key: key, Field: field, Value: value, Own: true})
	for cl := range rm.clients {
		if cl == from {
			enqueue(cl, own)
		} else {
			enqueue(cl, msg)
		}
	}
}

// add creates a free track from a JSON object of fields, unless the room is
// full or the value isn't a valid track.
func (rm *room) add(value json.RawMessage) {
	var fields map[string]json.RawMessage
	if len(rm.tracks) >= maxTracks || len(value) > maxTrackSize ||
		json.Unmarshal(value, &fields) != nil || fields == nil || len(fields) > maxFields {
		return
	}
	for f := range fields {
		if !validField.MatchString(f) {
			return
		}
	}
	n := rm.nextTrack
	rm.nextTrack++
	rm.tracks[n] = &track{fields: fields}
	rm.seeded = true
	rm.broadcast(nil, trackKey(n), "", rm.trackValue(n))
}

// remove deletes the track if the user may edit it.
func (rm *room) remove(user string, n int) {
	if !rm.canEdit(user, n) {
		return
	}
	delete(rm.tracks, n)
	rm.broadcast(nil, trackKey(n), "", nil)
}

// seed gives a new room its first tracks, taken from the first client's saved
// ones. Clients joining at the same time (e.g. after a server restart) all
// send their own, so only the first seed counts.
func (rm *room) seed(values []json.RawMessage) {
	if rm.seeded {
		return
	}
	rm.seeded = true
	for _, v := range values {
		rm.add(v)
	}
	// Clients that joined the empty room get an instrument now
	claimed := false
	for c := range rm.clients {
		if rm.claimFree(c.user) {
			claimed = true
		}
	}
	if claimed {
		rm.broadcastOwners()
	}
}

// claim gives the track to the user, releasing any track they had before.
func (rm *room) claim(user string, n int) {
	if t := rm.tracks[n]; t == nil || t.owner != "" {
		return
	}
	if old := rm.trackOf(user); old >= 0 {
		rm.tracks[old].owner = ""
	}
	rm.tracks[n].owner = user
	rm.broadcastOwners()
}

// claimFree gives a user without a track the first free one, if any.
func (rm *room) claimFree(user string) bool {
	if rm.trackOf(user) >= 0 {
		return false
	}
	for _, n := range slices.Sorted(maps.Keys(rm.tracks)) {
		if rm.tracks[n].owner == "" {
			rm.tracks[n].owner = user
			return true
		}
	}
	return false
}

func (rm *room) release(user string, n int) {
	if t := rm.tracks[n]; t == nil || t.owner != user {
		return
	}
	rm.tracks[n].owner = ""
	rm.broadcastOwners()
}

func (rm *room) trackOf(user string) int {
	for n, t := range rm.tracks {
		if t.owner == user {
			return n
		}
	}
	return -1
}

// canEdit reports whether the user may change the track: free tracks are open
// to everyone, claimed ones only to their owner.
func (rm *room) canEdit(user string, n int) bool {
	t := rm.tracks[n]
	return t != nil && (t.owner == "" || t.owner == user)
}

// ownersFor describes ownership from one user's point of view, so user IDs
// (which double as credentials) are never sent to other clients.
func (rm *room) ownersFor(user string) json.RawMessage {
	view := make(map[string]string)
	for n, t := range rm.tracks {
		switch t.owner {
		case "":
		case user:
			view[strconv.Itoa(n)] = "me"
		default:
			view[strconv.Itoa(n)] = "other"
		}
	}
	out, _ := json.Marshal(view)
	return out
}

func (rm *room) broadcastOwners() {
	for c := range rm.clients {
		msg, _ := json.Marshal(outbound{Type: "set", Key: "owners", Value: rm.ownersFor(c.user)})
		enqueue(c, msg)
	}
}

// enqueue never blocks; a client that can't keep up is disconnected.
func enqueue(c *client, msg []byte) {
	select {
	case c.send <- msg:
	default:
		c.kick()
	}
}
