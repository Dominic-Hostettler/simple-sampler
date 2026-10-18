// Kick: a pitch-swept sine, an optional triangle layer and a noise click.

import { lerp } from '../synth.js';

export default {
  id: 'kick',
  name: 'Kick',
  color: 'green',
  params: { pitch: 0.25, bend: 0.8, decay: 0.4, timbre: 0.0, punch: 0.3, gain: 1.0, distortion: 0.0 },
  knobs: [
    { key: 'pitch', label: 'Pitch' },
    { key: 'bend', label: 'Bend' },
    { key: 'decay', label: 'Decay' },
    { key: 'timbre', label: 'Timbre' },
    { key: 'punch', label: 'Punch' },
    { key: 'gain', label: 'Vol' },
    { key: 'distortion', label: 'Dist' }
  ],
  steps: [true,false,false,false, true,false,false,false, true,false,false,false, true,false,false,false],

  play(ctx, time, p, stepGain, destination) {
    const gain = p.gain * stepGain;
    const startFreq = lerp(40, 300, p.pitch);
    const endFreq = lerp(10, startFreq, 1 - p.bend);
    const decay = lerp(0.05, 1.5, p.decay);
    const timbre = p.timbre;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    const g1 = ctx.createGain();
    osc1.frequency.setValueAtTime(startFreq, time);
    osc1.frequency.exponentialRampToValueAtTime(Math.max(0.01, endFreq), time + decay);
    g1.gain.setValueAtTime(gain * (1 - timbre), time);
    g1.gain.exponentialRampToValueAtTime(0.001, time + decay);
    osc1.connect(g1).connect(destination);
    osc1.start(time);
    osc1.stop(time + decay);

    if (timbre > 0) {
      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      const g2 = ctx.createGain();
      osc2.frequency.setValueAtTime(startFreq, time);
      osc2.frequency.exponentialRampToValueAtTime(Math.max(0.01, endFreq), time + decay);
      g2.gain.setValueAtTime(gain * timbre * 0.7, time);
      g2.gain.exponentialRampToValueAtTime(0.001, time + decay);
      osc2.connect(g2).connect(destination);
      osc2.start(time);
      osc2.stop(time + decay);
    }

    if (p.punch > 0) {
      const clickDur = 0.04;
      const buf = ctx.createBuffer(1, ctx.sampleRate * clickDur, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const click = ctx.createBufferSource();
      click.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1000;
      const gClick = ctx.createGain();
      gClick.gain.setValueAtTime(gain * p.punch * 0.8, time);
      gClick.gain.exponentialRampToValueAtTime(0.001, time + clickDur);
      click.connect(hp).connect(gClick).connect(destination);
      click.start(time);
      click.stop(time + clickDur);
    }
  },
};
