// Knobs: drag up or down to change one param of a track.

import { canEdit } from './sequencer.js';
import { saveState } from './storage.js';

const sensitivity = 120; // pixels for the full range

// Returns a function that redraws the knob from the track's current value.
// share() is called on every change and must have a flush() for the drag end.
export function attachKnob(el, track, knobDef, share) {
  const indicator = el.querySelector('.knob-indicator');
  const valueLabel = el.querySelector('.knob-value');
  const param = knobDef.key;

  function update() {
    const v = track.params[param];
    const angle = -135 + v * 270;
    indicator.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    valueLabel.textContent = knobDef.display ? knobDef.display(v) : Math.round(v * 100);
  }
  update();

  let startY = 0;
  let startValue = 0;

  function onMove(e) {
    e.preventDefault();
    const delta = startY - e.clientY;
    let newVal = startValue + delta / sensitivity;
    newVal = Math.max(0, Math.min(1, newVal));
    track.params[param] = newVal;
    update();
    share();
  }

  function onEnd() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onEnd);
    document.removeEventListener('pointercancel', onEnd);
    track.dragging = false;
    share.flush();
    saveState();
  }

  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!canEdit(track)) return;
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    track.dragging = true;
    startY = e.clientY;
    startValue = track.params[param];
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  });

  return update;
}
