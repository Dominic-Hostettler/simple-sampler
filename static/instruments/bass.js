// Bass: one oscillator through a resonant low-pass with its own envelope.
// Pitched: each step has a note, in semitones above the root.

import { lerp, waveAt } from '../synth.js';

const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const rootMidi = v => 24 + Math.round(v * 11); // C1..B1

export const noteName = midi => noteNames[midi % 12] + (Math.floor(midi / 12) - 1);

export default {
  id: 'bass',
  name: 'Bass',
  color: 'blue',
  pitched: true,
  params: { root: 0, wave: 0.6, cutoff: 0.35, resonance: 0.3, env: 0.5, decay: 0.35, gain: 0.8, distortion: 0.0 },
  knobs: [
    { key: 'root', label: 'Root', display: v => noteName(rootMidi(v)) },
    { key: 'wave', label: 'Wave', display: v => waveAt(v) },
    { key: 'cutoff', label: 'Cutoff' },
    { key: 'resonance', label: 'Reso' },
    { key: 'env', label: 'Env' },
    { key: 'decay', label: 'Decay' },
    { key: 'gain', label: 'Vol' },
    { key: 'distortion', label: 'Dist' }
  ],
  steps: [true,false,false,true, false,false,true,false, false,false,true,false, false,true,false,false],
  notes: [0,0,0,12, 0,0,0,0, 0,0,7,0, 0,10,0,0],

  noteLabel: (p, note) => noteName(rootMidi(p.root) + note),

  // Returns a function that cuts the note at a given time, so the track stays mono.
  play(ctx, time, p, stepGain, destination, note = 0) {
    const gain = p.gain * stepGain * 0.6;
    const freq = 440 * Math.pow(2, (rootMidi(p.root) + note - 69) / 12);
    const decay = lerp(0.08, 1.5, p.decay);
    const cutoff = lerp(80, 4000, p.cutoff);
    const peak = Math.min(18000, cutoff * lerp(1, 8, p.env));

    const osc = ctx.createOscillator();
    osc.type = waveAt(p.wave);
    osc.frequency.setValueAtTime(freq, time);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = lerp(0.5, 15, p.resonance);
    lp.frequency.setValueAtTime(peak, time);
    lp.frequency.exponentialRampToValueAtTime(cutoff, time + decay * 0.5);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(gain, time + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, time + decay);

    const choke = ctx.createGain();
    osc.connect(lp).connect(env).connect(choke).connect(destination);
    osc.start(time);
    osc.stop(time + decay);

    // A cut before the note starts (e.g. by a preview) is ignored
    return at => {
      if (at < time || at >= time + decay) return;
      choke.gain.setTargetAtTime(0, at, 0.005);
      osc.stop(at + 0.05);
    };
  },
};
