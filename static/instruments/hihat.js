// Hi-hat: noise through a high-pass and a band-pass filter.

import { lerp } from '../synth.js';

export default {
  id: 'hihat',
  name: 'Hi-Hat',
  color: 'yellow',
  params: { pitch: 0.45, resonance: 0.2, decay: 0.15, body: 0.4, mix: 0.2, gain: 0.7, distortion: 0.0 },
  knobs: [
    { key: 'pitch', label: 'Pitch' },
    { key: 'resonance', label: 'Reso' },
    { key: 'decay', label: 'Decay' },
    { key: 'body', label: 'Body' },
    { key: 'mix', label: 'Mix' },
    { key: 'gain', label: 'Vol' },
    { key: 'distortion', label: 'Dist' }
  ],
  steps: [true,false,true,false, true,false,true,false, true,false,true,false, true,false,true,false],

  play(ctx, time, p, stepGain, destination) {
    const gain = p.gain * stepGain;
    const cutoff = lerp(2000, 16000, p.pitch);
    const q = lerp(0, 30, p.resonance);
    const decay = lerp(0.02, 0.8, p.decay);
    const bodyFreq = lerp(1000, 8000, p.body);
    const mix = p.mix;

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * (decay + 0.05), ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = cutoff;
    hp.Q.value = q;
    const g1 = ctx.createGain();
    noise.connect(hp).connect(g1).connect(destination);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = bodyFreq;
    bp.Q.value = q;
    const g2 = ctx.createGain();
    noise.connect(bp).connect(g2).connect(destination);

    g1.gain.setValueAtTime(gain * (1 - mix) * 0.8, time);
    g1.gain.exponentialRampToValueAtTime(0.001, time + decay);
    g2.gain.setValueAtTime(gain * mix * 0.8, time);
    g2.gain.exponentialRampToValueAtTime(0.001, time + decay);

    noise.start(time);
    noise.stop(time + decay + 0.05);
  },
};
