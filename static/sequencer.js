// Tracks, the shared transport and the step scheduler.
//
// Emits on `events`:
//   'step'      detail: step index that is heard now
//   'transport' after the transport changed (play/stop/tempo)
//   'track'     detail: track whose pattern, sound, presets or owner changed
//   'tracks'    after tracks were added, removed or replaced

import { audioCtx, playTrack } from './synth.js';
import { instruments, defaultKit } from './instruments/index.js';
import { serverNow, toPerformanceTime, send, listen, claim, release, add, remove, seed, isOnline } from './net.js';

export const events = new EventTarget();

export const NUM_STEPS = 16;
export const MAX_PRESETS = 16; // per row, keeps the shared track value small
export const MAX_TRACKS = 8;   // same limit as the server

export const state = {
  // Shared transport, in server time (ms). Step n plays at
  // anchorTime + (n - anchorStep) * stepDuration; a tempo change sets a new anchor.
  transport: { playing: false, bpm: 120, anchorTime: 0, anchorStep: 0, started: 0 },
};

// Tracks in display order, by ID. track.instrument (a module from instruments/)
// defines the sound and knobs; everything else is the track's own state.
export const tracks = [];
let owners = {}; // latest ownership view from the server, by track ID

function ownerOf(id) {
  const owner = owners[id];
  return owner === 'me' || owner === 'other' ? owner : null;
}

function makeTrack(id, v) {
  return {
    id,
    ...v,               // instrument, steps, params, muted, presets, patternPresets
    owner: ownerOf(id), // 'me', 'other' or null when free
    pending: {},        // own writes per field still waiting for the server's reply
  };
}

// The shared value of a track, also what localStorage keeps.
export function trackValue(track) {
  return {
    instrument: track.instrument.id, steps: track.steps, params: track.params, muted: track.muted,
    presets: track.presets, patternPresets: track.patternPresets,
  };
}

function newTrackValue(instrument, steps = []) {
  return { instrument: instrument.id, steps, params: { ...instrument.params } };
}

// Replaces the tracks with local ones (saved or the default kit), numbered from 0.
// Returns false and keeps the current tracks if none of the values is valid.
export function loadTracks(values) {
  const loaded = values.map(cleanTrack).filter(Boolean);
  if (!loaded.length) return false;
  tracks.splice(0, tracks.length, ...loaded.map((v, i) => makeTrack(i, v)));
  return true;
}

const lookahead = 25.0;
const scheduleAheadTime = 0.1;
const startLead = 300;    // ms of headroom so every client receives a change before it takes effect
let timerID = null;
let timings = [];         // transports of the current run still needed, oldest first; see timeOfStep
let nextStep = 0;         // absolute index of the next step to schedule

export function fitSteps(steps) {
  return Array.from({ length: NUM_STEPS }, (_, i) => steps[i] || false);
}

export function canEdit(track) { return track.owner !== 'other'; }

// ---------- Timing ----------
function stepDuration(t) { return 60000 / t.bpm / 4; }
function stepTime(t, n) { return t.anchorTime + (n - t.anchorStep) * stepDuration(t); }
function stepAt(t, time) { return t.anchorStep + (time - t.anchorTime) / stepDuration(t); }
// Steps before a tempo change's anchor keep the timing they had.
function timeOfStep(n) {
  return stepTime(timings.findLast(t => t.anchorStep <= n) ?? timings[0], n);
}

// Converts server time (ms) to the AudioContext time at which a sound scheduled
// then is actually heard, so devices with different output latency stay aligned.
function toAudioTime(serverMs) {
  const perfMs = toPerformanceTime(serverMs);
  const ts = audioCtx.getOutputTimestamp ? audioCtx.getOutputTimestamp() : {};
  if (ts.performanceTime) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
  return audioCtx.currentTime + (perfMs - performance.now()) / 1000 - (audioCtx.outputLatency || 0);
}

// ---------- Scheduler ----------
function scheduleNote(step, time) {
  tracks.forEach(track => {
    if (track.steps[step]) playTrack(track, time, track.steps[step]);
  });
}

function scheduler() {
  const now = serverNow();
  // The cap only matters after a big clock jump, where it skips ahead in a few ticks
  for (let i = 0; i < 64 && timeOfStep(nextStep) < now + scheduleAheadTime * 1000; i++) {
    const time = timeOfStep(nextStep);
    // Steps already in the past (e.g. after a clock correction) are skipped
    if (time >= now) {
      const step = nextStep % NUM_STEPS;
      scheduleNote(step, toAudioTime(time));
      showStep(step, time);
    }
    nextStep++;
  }
  while (timings.length > 1 && timings[1].anchorStep <= nextStep) timings.shift();
}

// Steps are scheduled ahead, so the UI is told when the step is actually heard.
function showStep(step, time) {
  const { started } = state.transport;
  setTimeout(() => {
    if (state.transport.playing && state.transport.started === started) {
      events.dispatchEvent(new CustomEvent('step', { detail: step }));
    }
  }, time - serverNow());
}

// ---------- Validation ----------
// Values come from other clients, so never trust their shape.
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const finite = v => typeof v === 'number' && Number.isFinite(v);

export function cleanBpm(bpm) {
  return finite(bpm) ? clamp(Math.round(bpm), 60, 200) : 120;
}

function cleanTransport(t) {
  if (!t || typeof t !== 'object') return null;
  const bpm = cleanBpm(t.bpm);
  if (!t.playing) return { playing: false, bpm };
  if (!finite(t.anchorTime) || !finite(t.started) || !Number.isInteger(t.anchorStep) || t.anchorStep < 0) return null;
  return { playing: true, bpm, anchorTime: t.anchorTime, anchorStep: t.anchorStep, started: t.started };
}

function cleanParams(instrument, p) {
  const params = {};
  for (const [key, value] of Object.entries(instrument.params)) {
    params[key] = finite(p?.[key]) ? clamp(p[key], 0, 1) : value;
  }
  return params;
}

function cleanSteps(steps) {
  if (!Array.isArray(steps)) steps = [];
  return fitSteps(steps.map(s => (s === true || s === 1 ? 1 : s === 0.25 ? 0.25 : 0)));
}

function cleanPresets(list, clean) {
  return Array.isArray(list) ? list.slice(0, MAX_PRESETS).map(clean) : [];
}

// Also used for the tracks restored from localStorage. Tracks with an
// unknown instrument (e.g. from a newer version) are dropped.
function cleanTrack(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.steps)) return null;
  const instrument = instruments.get(v.instrument);
  if (!instrument) return null;
  return {
    instrument,
    steps: cleanSteps(v.steps),
    params: cleanParams(instrument, v.params),
    muted: v.muted === true,
    presets: cleanPresets(v.presets, p => cleanParams(instrument, p)),
    patternPresets: cleanPresets(v.patternPresets, cleanSteps),
  };
}

// ---------- Applying shared state ----------
function applyTransport(value) {
  const t = cleanTransport(value);
  if (!t) return;
  const old = state.transport;
  state.transport = t;
  if (!t.playing) {
    timings = [];
    clearInterval(timerID);
    timerID = null;
  } else if (old.playing && t.started === old.started) {
    // Tempo change: it replaces earlier changes from its anchor on
    timings = timings.filter(x => x.anchorStep < t.anchorStep);
    timings.push(t);
  } else {
    timings = [t];
    nextStep = Math.max(t.anchorStep, Math.ceil(stepAt(t, serverNow())));
    if (!timerID) timerID = setInterval(scheduler, lookahead);
  }
  events.dispatchEvent(new Event('transport'));
}

function trackChanged(track) {
  events.dispatchEvent(new CustomEvent('track', { detail: track }));
}

function tracksChanged() {
  events.dispatchEvent(new Event('tracks'));
}

function applyOwners(value) {
  owners = value && typeof value === 'object' ? value : {};
  tracks.forEach(track => {
    track.owner = ownerOf(track.id);
    trackChanged(track);
  });
}

function assignTrack(track, v) {
  // Another instrument needs other knobs, so the track is drawn anew
  const replaced = v.instrument !== track.instrument;
  Object.assign(track, v);
  if (replaced) tracksChanged();
  else trackChanged(track);
}

function applyField(track, field, value, own) {
  // Own edits apply locally right away. The reply to an older own write would
  // undo newer edits still in flight, so only the reply to the latest applies.
  if (own) {
    track.pending[field] = Math.max(0, (track.pending[field] || 0) - 1);
    if (track.pending[field] > 0) return;
  }
  // While the local user drags a knob, echoes of their own earlier values would make it jump
  if (track.dragging && field === 'params') return;
  // Cleaned together with the other fields, since e.g. params depend on the instrument
  const v = cleanTrack({ ...trackValue(track), [field]: value });
  if (v) assignTrack(track, v);
}

function trackIdOf(key) {
  const m = /^track\.(0|[1-9]\d*)$/.exec(key);
  return m ? Number(m[1]) : null;
}

// Updates one field of the track, or without field adds, replaces or
// (without a value) removes the whole track.
function applyTrackKey(id, field, value, own) {
  const i = tracks.findIndex(t => t.id === id);
  if (field) {
    if (i >= 0) applyField(tracks[i], field, value, own);
  } else if (value === undefined) {
    if (i < 0) return;
    tracks.splice(i, 1);
    tracksChanged();
  } else if (i >= 0) {
    const v = cleanTrack(value);
    if (v) assignTrack(tracks[i], v);
  } else {
    const v = cleanTrack(value);
    if (!v) return;
    tracks.push(makeTrack(id, v));
    tracks.sort((a, b) => a.id - b.id);
    tracksChanged();
  }
}

listen({
  state(shared) {
    // An empty room adopts the first client's settings
    if ('transport' in shared) applyTransport(shared.transport);
    else send('transport', { playing: false, bpm: state.transport.bpm });

    // The room's tracks replace the local ones. Fresh objects also drop
    // writes sent on an earlier connection, which get no reply.
    const local = tracks.map(trackValue);
    const entries = Object.entries(shared)
      .map(([key, value]) => [trackIdOf(key), value])
      .filter(([id]) => id !== null);
    tracks.length = 0;
    owners = {};
    for (const [id, value] of entries) {
      const v = cleanTrack(value);
      if (v) tracks.push(makeTrack(id, v));
    }
    tracks.sort((a, b) => a.id - b.id);
    // An empty room gets this client's tracks: its saved copy of the room
    // (after a server restart) or the default kit. The server ignores the
    // seed if another client was first, or if all tracks were removed.
    if (!entries.length) seed(local);
    applyOwners(shared.owners);
    tracksChanged();
  },
  set(key, value, own, field) {
    if (key === 'transport') applyTransport(value);
    else if (key === 'owners') applyOwners(value);
    else {
      const id = trackIdOf(key);
      if (id !== null) applyTrackKey(id, field, value, own);
    }
  },
});

// ---------- Actions ----------
// Transport changes only apply when the server echoes them back, so every
// client applies them in the same order. Track edits apply locally right away
// and the echo confirms them.
export function play() {
  const start = serverNow() + startLead;
  send('transport', { playing: true, bpm: state.transport.bpm, anchorTime: start, anchorStep: 0, started: start });
}

export function stop() {
  send('transport', { playing: false, bpm: state.transport.bpm });
}

export function setBpm(value) {
  const t = state.transport;
  if (value === t.bpm) return;
  if (!t.playing) {
    send('transport', { ...t, bpm: value });
    return;
  }
  const anchorStep = Math.max(t.anchorStep, Math.ceil(stepAt(t, serverNow() + startLead)));
  send('transport', { ...t, bpm: value, anchorStep, anchorTime: stepTime(t, anchorStep) });
}

// Sends the given fields of the track (e.g. 'steps', 'params'). Offline there's
// nobody to share with, and the local track is already up to date.
// A track replaced in the meantime (e.g. by a reconnect) is no longer shared.
export function shareTrack(track, ...fields) {
  if (!isOnline() || !canEdit(track) || !tracks.includes(track)) return;
  const value = trackValue(track);
  for (const field of fields) {
    track.pending[field] = (track.pending[field] || 0) + 1;
    send('track.' + track.id, value[field], field);
  }
}

export function resetSound(track) {
  track.params = { ...track.instrument.params };
  trackChanged(track);
  shareTrack(track, 'params');
}

// Online, adding and removing apply when the server echoes them; offline the
// change is only local.
export function addTrack(instrument) {
  if (tracks.length >= MAX_TRACKS) return;
  const value = newTrackValue(instrument);
  if (isOnline()) add(value);
  else applyTrackKey(Math.max(-1, ...tracks.map(t => t.id)) + 1, null, value);
}

export function removeTrack(track) {
  if (!canEdit(track)) return;
  if (isOnline()) remove(track.id);
  else applyTrackKey(track.id, null, undefined);
}

export function claimTrack(track) { claim(track.id); }
export function releaseTrack(track) { release(track.id); }

loadTracks(defaultKit.map(instrument => newTrackValue(instrument, instrument.steps)));
