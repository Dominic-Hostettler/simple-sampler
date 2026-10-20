// The instruments a track can play. To add one, write a module like kick.js
// and list it here. Each module exports:
//   id      key stored in the shared track value; never rename it
//   name    shown on the track
//   color   one of the step colors in style.css
//   params  default knob values, all 0..1; every instrument has gain and distortion
//   knobs   { key, label, display? } per param, in display order
//   steps   default pattern for a new room
//   play(ctx, time, params, stepGain, destination, note)  schedules one hit;
//           may return a function(time) that cuts it, called at the track's next hit
// Pitched instruments also have:
//   pitched true; tracks then have a note per step, 0..MAX_NOTE semitones above the root
//   notes   default notes for a new room
//   noteLabel(params, note)  shown on the step

import kick from './kick.js';
import snare from './snare.js';
import hihat from './hihat.js';
import bass from './bass.js';

const all = [kick, snare, hihat, bass];

export const instruments = new Map(all.map(i => [i.id, i]));

// The tracks a new room starts with when there's nothing saved
export const defaultKit = all;
