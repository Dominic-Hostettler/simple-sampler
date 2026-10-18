// Keeps a copy of each room (tempo, patterns, sounds, presets) in localStorage,
// so the room can be restored after a server restart. A new room starts with
// the default kit.

import { state, tracks, trackValue, loadTracks, cleanBpm } from './sequencer.js';
import { roomId } from './net.js';

const maxRooms = 20; // copies kept, the least recently used is dropped
const indexKey = 'simpelSamplerRooms'; // room IDs, most recently used first
const roomKey = id => 'simpelSamplerRoom.' + id;

// Before rooms were kept separately, one copy was shared by all rooms
try { localStorage.removeItem('simpelSamplerState'); } catch (e) { /* storage blocked */ }

function savedRooms() {
  try {
    const ids = JSON.parse(localStorage.getItem(indexKey));
    return Array.isArray(ids) ? ids : [];
  } catch (e) {
    return [];
  }
}

function saveNow() {
  if (!roomId) return;
  const data = {
    bpm: state.transport.bpm,
    tracks: tracks.map(trackValue),
  };
  try {
    localStorage.setItem(roomKey(roomId), JSON.stringify(data));
    const ids = [roomId, ...savedRooms().filter(id => id !== roomId)];
    ids.slice(maxRooms).forEach(id => localStorage.removeItem(roomKey(id)));
    localStorage.setItem(indexKey, JSON.stringify(ids.slice(0, maxRooms)));
  } catch (e) {
    console.warn('Could not save sampler state', e);
  }
}

// Remote edits arrive many times a second, so batch saves.
let saveTimer = null;
export function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 500);
}
addEventListener('pagehide', () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveNow();
});

// Loads this room's copy, if there is one.
export function loadState() {
  if (!roomId) return;
  try {
    const raw = localStorage.getItem(roomKey(roomId));
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.bpm) state.transport.bpm = cleanBpm(data.bpm);
    // Same validation as remote values. Without any valid track the default kit stays.
    if (Array.isArray(data.tracks)) loadTracks(data.tracks);
  } catch (err) {
    console.error('Failed to load sampler state', err);
  }
}
