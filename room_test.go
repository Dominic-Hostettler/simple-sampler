package main

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func testRoom() *room { return newRoom(&sync.Mutex{}, "127.0.0.1") }

func testClient(user string) *client {
	return &client{user: user, send: make(chan []byte, 256), kick: func() {}}
}

// received drains and decodes everything sent to the client.
func received(c *client) []outbound {
	var msgs []outbound
	for {
		select {
		case data := <-c.send:
			var m outbound
			json.Unmarshal(data, &m)
			msgs = append(msgs, m)
		default:
			return msgs
		}
	}
}

func lastSet(t *testing.T, c *client) outbound {
	t.Helper()
	msgs := received(c)
	if len(msgs) == 0 {
		t.Fatal("no message")
	}
	return msgs[len(msgs)-1]
}

// roomWithTrack has one track, claimed by alice.
func roomWithTrack(t *testing.T) (*room, *client, *client) {
	t.Helper()
	rm := testRoom()
	rm.add(json.RawMessage(`{"instrument":"kick","steps":[1,0]}`))
	alice, bob := testClient("alice"), testClient("bob")
	rm.join(alice)
	rm.join(bob)
	if rm.tracks[0].owner != "alice" {
		t.Fatalf("owner = %q, want alice", rm.tracks[0].owner)
	}
	received(alice)
	received(bob)
	return rm, alice, bob
}

func TestTrackID(t *testing.T) {
	for key, want := range map[string]bool{"track.0": true, "track.12": true, "track.01": false, "track.": false, "track.x": false, "tracks.1": false, "transport": false} {
		if _, ok := trackID(key); ok != want {
			t.Errorf("trackID(%q) ok = %v, want %v", key, ok, want)
		}
	}
}

func TestSetOnlyTransportAndTrackFields(t *testing.T) {
	rm, alice, _ := roomWithTrack(t)
	rm.set(alice, "junk", "", json.RawMessage(`1`))
	rm.set(alice, "owners", "", json.RawMessage(`{}`))
	if msgs := received(alice); len(msgs) != 0 {
		t.Errorf("other keys got replies: %+v", msgs)
	}

	rm.set(alice, "transport", "", json.RawMessage(`{"playing":false}`))
	if m := lastSet(t, alice); m.Key != "transport" || !m.Own || string(m.Value) != `{"playing":false}` {
		t.Errorf("transport echo = %+v", m)
	}
}

func TestSetField(t *testing.T) {
	rm, alice, bob := roomWithTrack(t)
	rm.set(alice, "track.0", "params", json.RawMessage(`{"gain":1}`))
	if got := string(rm.tracks[0].fields["params"]); got != `{"gain":1}` {
		t.Errorf("params = %s", got)
	}
	if string(rm.tracks[0].fields["steps"]) != `[1,0]` {
		t.Error("other fields changed")
	}
	if m := lastSet(t, alice); !m.Own || m.Field != "params" {
		t.Errorf("own echo = %+v", m)
	}
	if m := lastSet(t, bob); m.Own || m.Field != "params" {
		t.Errorf("broadcast = %+v", m)
	}
}

func TestSetRejected(t *testing.T) {
	rm, alice, bob := roomWithTrack(t)
	cases := []struct {
		name       string
		c          *client
		key, field string
		value      string
		wantKey    string
		wantField  string
		wantValue  string
	}{
		{"not the owner", bob, "track.0", "steps", `[0,0]`, "track.0", "steps", `[1,0]`},
		{"invalid field", alice, "track.0", "a.b", `1`, "track.0", "a.b", ``},
		{"too big", alice, "track.0", "steps", `"` + strings.Repeat("x", maxTrackSize) + `"`, "track.0", "steps", `[1,0]`},
		{"removed track", alice, "track.5", "steps", `[]`, "track.5", "", ``},
	}
	for _, tc := range cases {
		rm.set(tc.c, tc.key, tc.field, json.RawMessage(tc.value))
		m := lastSet(t, tc.c)
		if !m.Own || m.Key != tc.wantKey || m.Field != tc.wantField || string(m.Value) != tc.wantValue {
			t.Errorf("%s: reply = %+v", tc.name, m)
		}
		other := bob
		if tc.c == bob {
			other = alice
		}
		if msgs := received(other); len(msgs) != 0 {
			t.Errorf("%s: broadcast %+v", tc.name, msgs)
		}
	}
	if string(rm.tracks[0].fields["steps"]) != `[1,0]` {
		t.Error("a rejected write changed the track")
	}
}

func TestFieldLimit(t *testing.T) {
	rm, alice, _ := roomWithTrack(t)
	for i := range maxFields {
		rm.set(alice, "track.0", "f"+strings.Repeat("x", i), json.RawMessage(`1`))
	}
	if n := len(rm.tracks[0].fields); n != maxFields {
		t.Errorf("fields = %d, want %d", n, maxFields)
	}
}

func TestAdd(t *testing.T) {
	rm := testRoom()
	for _, v := range []string{`null`, `[]`, `1`, `{"a.b":1}`, `{`} {
		rm.add(json.RawMessage(v))
	}
	if len(rm.tracks) != 0 {
		t.Fatalf("invalid values added %d tracks", len(rm.tracks))
	}
	for range maxTracks + 2 {
		rm.add(json.RawMessage(`{"instrument":"kick"}`))
	}
	if len(rm.tracks) != maxTracks {
		t.Errorf("tracks = %d, want %d", len(rm.tracks), maxTracks)
	}
}

func TestRemove(t *testing.T) {
	rm, alice, bob := roomWithTrack(t)
	rm.remove("bob", 0)
	if rm.tracks[0] == nil {
		t.Fatal("bob removed alice's track")
	}
	rm.remove("alice", 0)
	if rm.tracks[0] != nil {
		t.Fatal("alice couldn't remove her track")
	}
	if m := lastSet(t, bob); m.Key != "track.0" || m.Value != nil {
		t.Errorf("removal = %+v", m)
	}
	// IDs are never reused
	rm.add(json.RawMessage(`{}`))
	if rm.tracks[1] == nil {
		t.Error("new track didn't get ID 1")
	}
	received(alice)
}

func TestSeedOnlyOnce(t *testing.T) {
	rm := testRoom()
	alice := testClient("alice")
	rm.join(alice)
	rm.seed([]json.RawMessage{json.RawMessage(`{"instrument":"kick"}`), json.RawMessage(`{"instrument":"snare"}`)})
	rm.seed([]json.RawMessage{json.RawMessage(`{"instrument":"hihat"}`)})
	if len(rm.tracks) != 2 {
		t.Errorf("tracks = %d, want 2", len(rm.tracks))
	}
	if rm.tracks[0].owner != "alice" {
		t.Error("the client in the empty room got no track after the seed")
	}

	// An emptied room stays empty
	rm.remove("alice", 0)
	rm.remove("alice", 1)
	rm.seed([]json.RawMessage{json.RawMessage(`{}`)})
	if len(rm.tracks) != 0 {
		t.Error("seed refilled an emptied room")
	}
}

func TestClaim(t *testing.T) {
	rm, alice, bob := roomWithTrack(t)
	rm.add(json.RawMessage(`{}`))
	rm.add(json.RawMessage(`{}`))

	rm.claim("bob", 0) // taken
	if rm.tracks[0].owner != "alice" {
		t.Error("bob took a claimed track")
	}
	rm.claim("alice", 2) // switching releases the old track
	if rm.tracks[0].owner != "" || rm.tracks[2].owner != "alice" {
		t.Error("claim didn't move alice's track")
	}
	rm.release("bob", 2)
	if rm.tracks[2].owner != "alice" {
		t.Error("bob released alice's track")
	}
	rm.release("alice", 2)
	if rm.tracks[2].owner != "" {
		t.Error("alice couldn't release her track")
	}

	// Owners are only described as "me" or "other"
	rm.claim("alice", 1)
	received(bob)
	rm.broadcastOwners()
	if m := lastSet(t, bob); string(m.Value) != `{"1":"other"}` {
		t.Errorf("bob's owners = %s", m.Value)
	}
	received(alice)
}

func TestLimiter(t *testing.T) {
	l := newLimiter(10, 3)
	for i := range 3 {
		if !l.allow() {
			t.Fatalf("burst message %d denied", i)
		}
	}
	if l.allow() {
		t.Fatal("message over the burst allowed")
	}
	l.last = l.last.Add(-200 * time.Millisecond) // 2 tokens later
	if !l.allow() || !l.allow() || l.allow() {
		t.Error("refill wrong")
	}
}
