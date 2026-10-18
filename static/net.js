// Connection to the room: WebSocket state sync and clock sync.

export const roomId = location.pathname.match(/^\/r\/([a-z0-9]+)/)?.[1] ?? null;

// Anonymous user ID, kept across reloads so a refresh keeps your track.
// crypto.randomUUID needs HTTPS, so build it from getRandomValues (works over plain LAN HTTP).
const userId = (() => {
  const key = 'simpelSamplerUser';
  try {
    const stored = localStorage.getItem(key);
    if (/^[a-f0-9]{32}$/.test(stored)) return stored;
  } catch (e) { /* storage blocked */ }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(key, id); } catch (e) { /* storage blocked */ }
  return id;
})();

let ws = null;
let clockOffset = 0;      // server clock minus client clock (ms)
const clockSamples = [];  // recent { rtt, offset } measurements
let synced = false;       // true once the clock offset is known
let queued = [];          // messages received before the clock was synced
let handlers = { state() {}, set() {} };
let retryDelay = 1000;    // grows while the server keeps refusing us, e.g. a full room

function clientNow() { return performance.timeOrigin + performance.now(); }
export function serverNow() { return clientNow() + clockOffset; }

// Converts server time (ms) to the performance.now() timeline.
export function toPerformanceTime(serverMs) {
  return serverMs - clockOffset - performance.timeOrigin;
}

export function listen(h) { handlers = h; }

export function isOnline() { return !!ws && ws.readyState === WebSocket.OPEN; }

// Writes the transport, or with a field, one field of a track.
export function send(key, value, field) {
  if (isOnline()) ws.send(JSON.stringify({ type: 'set', key, field, value }));
  else handlers.set(key, value, false, field); // offline: act locally
}

// Requests the server decides on; offline they're dropped.
function request(msg) {
  if (isOnline()) ws.send(JSON.stringify(msg));
}

export function claim(track) { request({ type: 'claim', track }); }
export function release(track) { request({ type: 'release', track }); }
export function add(value) { request({ type: 'add', value }); }
export function remove(track) { request({ type: 'remove', track }); }
export function seed(values) { request({ type: 'seed', value: values }); }

function handleMessage(msg) {
  if (msg.type === 'state') handlers.state(msg.state || {});
  else if (msg.type === 'set') handlers.set(msg.key, msg.value, msg.own === true, msg.field);
}

function onPong(msg) {
  const now = clientNow();
  const rtt = now - msg.t;
  clockSamples.push({ rtt, offset: msg.server + rtt / 2 - now });
  if (clockSamples.length > 10) clockSamples.shift();
  // The fastest round trip has the least network jitter, so trust it most
  clockOffset = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  if (!synced) {
    synced = true;
    queued.forEach(handleMessage);
    queued = [];
  }
}

export function connect() {
  if (!roomId) return;
  const url = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/ws/${roomId}?user=${userId}`;
  const socket = new WebSocket(url);
  ws = socket;
  synced = false;
  queued = [];
  let pingTimer = null;
  const ping = () => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', t: clientNow() }));
  };

  socket.addEventListener('open', () => {
    for (let i = 0; i < 5; i++) setTimeout(ping, i * 100);
    pingTimer = setInterval(ping, 2000);
  });
  socket.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') retryDelay = 1000;
    if (msg.type === 'pong') onPong(msg);
    else if (synced) handleMessage(msg);
    else queued.push(msg);
  });
  socket.addEventListener('close', () => {
    clearInterval(pingTimer);
    if (ws !== socket) return;
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  });
}
