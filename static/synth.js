// Shared sound helpers. The instruments themselves live in instruments/.

const AudioContext = window.AudioContext || window.webkitAudioContext;
export const audioCtx = new AudioContext();

// All tracks are summed here; the limiter keeps several loud hits from clipping.
// Its fixed lookahead (a few ms) is the same on every client, so sync is unaffected.
const master = audioCtx.createDynamicsCompressor();
master.threshold.value = -3;
master.knee.value = 0;
master.ratio.value = 20;
master.attack.value = 0.003;
master.release.value = 0.1;
master.connect(audioCtx.destination);

export function lerp(a, b, t) { return a + (b - a) * t; }

// tanh(k·x) / tanh(k) goes from clean (k near 0) to hard clipping (amount 1).
// Curves are cached in steps of 0.01; null means no distortion.
const curves = new Map();
function distortionCurve(amount) {
  const level = Math.round(amount * 100);
  if (level <= 0) return null;
  if (!curves.has(level)) {
    const samples = 4096;
    const curve = new Float32Array(samples);
    const k = level / 5;
    for (let i = 0; i < samples; i++) {
      const x = i * 2 / samples - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    curves.set(level, curve);
  }
  return curves.get(level);
}

const waveTypes = ['sine', 'triangle', 'sawtooth', 'square'];
export function waveAt(v) {
  return waveTypes[Math.min(waveTypes.length - 1, Math.floor(v * waveTypes.length))];
}

export function playTrack(track, time, stepGain = 1) {
  if (track.muted) return;
  let destination = master;
  const curve = distortionCurve(track.params.distortion);
  if (curve) {
    destination = audioCtx.createWaveShaper();
    destination.curve = curve;
    destination.oversample = '4x';
    destination.connect(master);
  }
  track.instrument.play(audioCtx, time, track.params, stepGain, destination);
}
