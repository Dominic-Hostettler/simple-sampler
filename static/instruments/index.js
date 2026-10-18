// The instruments a track can play. To add one, write a module like kick.js
// and list it here. Each module exports:
//   id      key stored in the shared track value; never rename it
//   name    shown on the track
//   color   one of the step colors in style.css
//   params  default knob values, all 0..1; every instrument has gain and distortion
//   knobs   { key, label, display? } per param, in display order
//   steps   default pattern for a new room
//   play(ctx, time, params, stepGain, destination)  schedules one hit

import kick from './kick.js';
import snare from './snare.js';
import hihat from './hihat.js';

const all = [kick, snare, hihat];

export const instruments = new Map(all.map(i => [i.id, i]));

// The tracks a new room starts with when there's nothing saved
export const defaultKit = all;
