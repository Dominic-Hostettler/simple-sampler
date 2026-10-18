# Simpel Sampler

Multiplayer drum machine in the browser: synthesized kick, snare and hi-hat, 16 steps, shared live
with everyone in a room. The beat is synced, not streamed: a small Go server orders the writes and
provides a clock, each browser plays locally with Web Audio.

## Usage

`/` opens a new room; share its link (`/r/<id>`). On join you get the first free track, which only
you can edit; free tracks are open to everyone. Up to 8 tracks. Rooms live in server memory; after a
restart the browsers restore them from their local copy.

## Run

```sh
go run .            # http://localhost:9090, PORT to change
docker compose up
air                 # dev: live reload, serves static/ from disk (DEV=1)
go test ./...
```

Go 1.27, no frontend build step. Install air with `go install github.com/air-verse/air@latest`.

## Adding an instrument

Add a module to `static/instruments/` (like `kick.js`) and list it in `instruments/index.js`.
The server doesn't know about instruments.

## Limits

50 rooms, 16 clients per room, per IP 32 connections and 10 rooms, 50 messages/s per connection.
Behind a reverse proxy the per-IP limits apply to all clients together.

## Layout

- `main.go`: HTTP, WebSocket, limits
- `room.go`: shared state, tracks, ownership
- `static/`: ES modules
  - `net.js`: WebSocket and clock sync
  - `sequencer.js`: tracks, transport, scheduler
  - `synth.js`, `instruments/`: sound
  - `ui.js`, `knobs.js`, `presets.js`: interface
  - `storage.js`: local copy of each room
