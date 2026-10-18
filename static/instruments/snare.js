// Snare: a tone oscillator plus high-passed noise.

import { lerp, waveAt } from '../synth.js';

export default {
  id: 'snare',
  name: 'Snare',
  color: 'red',
  params: { tone: 0.3, wave: 0.3, snap: 0.15, noise: 0.7, decay: 0.35, gain: 1.0, distortion: 0.0 },
  knobs: [
    { key: 'tone', label: 'Tone' },
    { key: 'wave', label: 'Wave', display: v => waveAt(v) },
    { key: 'snap', label: 'Snap' },
    { key: 'noise', label: 'Noise' },
    { key: 'decay', label: 'Decay' },
    { key: 'gain', label: 'Vol' },
    { key: 'distortion', label: 'Dist' }
  ],
  steps: [false,false,false,false, true,false,false,false, false,false,false,false, true,false,false,false],

  play(ctx, time, p, stepGain, destination) {
    const gain = p.gain * stepGain;
    const toneFreq = lerp(80, 400, p.tone);
    const decay = lerp(0.05, 1.0, p.decay);

    const osc = ctx.createOscillator();
    osc.type = waveAt(p.wave);
    const g1 = ctx.createGain();
    osc.frequency.setValueAtTime(toneFreq, time);
    g1.gain.setValueAtTime(gain * 0.6, time);
    g1.gain.exponentialRampToValueAtTime(0.001, time + decay);
    osc.connect(g1).connect(destination);
    osc.start(time);
    osc.stop(time + decay + 0.05);

    const noiseFilter = lerp(500, 10000, p.snap);
    const noiseGain = lerp(0, 1.8, p.noise);
    if (noiseGain > 0) {
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * (decay + 0.1), ctx.sampleRate);
      const noiseData = noiseBuf.getChannelData(0);
      for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = noiseFilter;
      filter.Q.value = 0.7;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(gain * noiseGain, time);
      g2.gain.exponentialRampToValueAtTime(0.001, time + decay);
      noise.connect(filter).connect(g2).connect(destination);
      noise.start(time);
      noise.stop(time + decay + 0.05);
    }
  },
};
