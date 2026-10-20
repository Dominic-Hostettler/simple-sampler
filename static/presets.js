// Preset rows under a track's steps: Sound (knob values) and Pattern (steps).
// Click Save to add a preset, drag Save onto a number to overwrite it,
// click a number to recall it, drag a number onto the bin to delete it.
//
// edit(track, fields, change) is the UI's way to change a track: it applies
// change() if the track may be edited, then shares the field(s), redraws and saves.

import { MAX_PRESETS } from './sequencer.js';

const binIcon = `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>
  <polyline points='3 6 5 6 21 6'></polyline>
  <path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'></path>
  <line x1='10' y1='11' x2='10' y2='17'></line>
  <line x1='14' y1='11' x2='14' y2='17'></line>
</svg>`;

const presetDragType = 'application/x-preset';
let drag = null; // { track, list, index } while a Save (index -1) or preset button is dragged

// Only drops within the same row count, so a Sound preset can't land in a Pattern row
function dragMatches(e, track, list) {
  return !!drag && drag.track === track && drag.list === list && e.dataTransfer.types.includes(presetDragType);
}

// Position of the i-th of n decorations on a ring just inside the button edge,
// clockwise starting from the top-left corner.
function edgePos(i, n) {
  const a = 0.12;
  const p = v => ((a + (1 - 2 * a) * v) * 100) + '%';
  const t = ((i / n) * 4) % 4;
  const s = Math.floor(t);
  const u = t - s;
  if (s === 0) return { left: p(u), top: p(0) };
  if (s === 1) return { left: p(1), top: p(u) };
  if (s === 2) return { left: p(1 - u), top: p(1) };
  return { left: p(0), top: p(1 - u) };
}

// Each attach function returns a function that redraws the row when the presets changed.

export function attachSoundPresets(row, track, edit) {
  const { instrument } = track;
  return attachPresetRow(row, track, edit, {
    list: 'presets',
    field: 'params',
    label: 'Sound',
    snapshot: () => ({ ...track.params }),
    restore: preset => { track.params = { ...preset }; },
    decorate: (b, preset) => {
      instrument.knobs.forEach((kn, i, arr) => {
        const k = document.createElement('span');
        k.className = 'p-knob preset-edge';
        const pos = edgePos(i, arr.length);
        k.style.left = pos.left;
        k.style.top = pos.top;
        const ind = document.createElement('span');
        ind.className = 'p-knob-ind';
        ind.style.transform = `translateX(-50%) rotate(${-135 + preset[kn.key] * 270}deg)`;
        k.appendChild(ind);
        b.appendChild(k);
      });
    },
  });
}

export function attachPatternPresets(row, track, edit) {
  const { instrument } = track;
  const { pitched } = instrument;
  return attachPresetRow(row, track, edit, {
    list: 'patternPresets',
    field: pitched ? ['steps', 'notes'] : 'steps',
    label: 'Pattern',
    snapshot: () => (pitched ? { steps: [...track.steps], notes: [...track.notes] } : [...track.steps]),
    restore: preset => {
      if (!pitched) { track.steps = [...preset]; return; }
      track.steps = [...preset.steps];
      track.notes = [...preset.notes];
    },
    decorate: (b, preset) => {
      (pitched ? preset.steps : preset).forEach((v, i, arr) => {
        const sq = document.createElement('span');
        sq.className = 'p-sq preset-edge';
        const pos = edgePos(i, arr.length);
        sq.style.left = pos.left;
        sq.style.top = pos.top;
        if (Number(v) === 1) sq.style.background = `var(--step-on-${instrument.color})`;
        else if (v) sq.style.background = `var(--step-half-${instrument.color})`;
        else { sq.style.background = 'var(--step-bg)'; sq.style.border = '1px solid var(--step-border)'; }
        b.appendChild(sq);
      });
    },
  });
}

// Redrawing only on change keeps a drag alive while other edits of the track arrive.
function attachPresetRow(row, track, edit, opts) {
  let shown = null;
  return () => {
    const json = JSON.stringify(track[opts.list]);
    if (json === shown) return;
    shown = json;
    renderPresetRow(row, track, edit, opts);
  };
}

// list: the track's presets field; field: what a preset restores
function renderPresetRow(row, track, edit, { list, field, label, snapshot, restore, decorate }) {
  row.innerHTML = '';
  const presets = track[list];

  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-btn';
  saveBtn.textContent = label;
  // A full row stays draggable, so its presets can still be overwritten
  saveBtn.title = presets.length >= MAX_PRESETS
    ? `At most ${MAX_PRESETS} presets: drag onto a number to overwrite it`
    : `Save ${label.toLowerCase()} (drag onto a number to overwrite it)`;
  saveBtn.draggable = true;
  saveBtn.addEventListener('click', () => {
    if (track[list].length >= MAX_PRESETS) return;
    edit(track, list, () => track[list].push(snapshot()));
  });
  saveBtn.addEventListener('dragstart', e => {
    drag = { track, list, index: -1 };
    e.dataTransfer.setData(presetDragType, '');
    e.dataTransfer.effectAllowed = 'copy';
  });
  saveBtn.addEventListener('dragend', () => { drag = null; });
  row.appendChild(saveBtn);

  const binEl = document.createElement('div');
  binEl.className = 'preset-bin';
  binEl.title = 'Drag a preset here to delete it';
  binEl.innerHTML = binIcon;
  binEl.addEventListener('dragover', e => {
    if (dragMatches(e, track, list) && drag.index >= 0) {
      e.preventDefault();
      binEl.classList.add('dragover');
    }
  });
  binEl.addEventListener('dragleave', () => binEl.classList.remove('dragover'));
  binEl.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    binEl.classList.remove('dragover');
    if (!dragMatches(e, track, list) || drag.index < 0) return;
    const { index } = drag;
    drag = null;
    edit(track, list, () => track[list].splice(index, 1));
  });

  presets.forEach((preset, i) => {
    const b = document.createElement('button');
    b.className = 'preset-btn';
    b.textContent = i + 1;
    b.title = 'Click to load, drag onto the bin to delete';
    b.draggable = true;
    b.addEventListener('dragstart', e => {
      drag = { track, list, index: i };
      e.dataTransfer.setData(presetDragType, '');
      e.dataTransfer.effectAllowed = 'move';
      binEl.classList.add('active');
    });
    b.addEventListener('dragend', () => {
      drag = null;
      binEl.classList.remove('active');
    });
    b.addEventListener('click', () => edit(track, field, () => restore(preset)));
    b.addEventListener('dragover', e => {
      if (dragMatches(e, track, list) && drag.index < 0) {
        e.preventDefault();
        b.classList.add('dragover');
      }
    });
    b.addEventListener('dragleave', () => b.classList.remove('dragover'));
    b.addEventListener('drop', e => {
      if (!dragMatches(e, track, list) || drag.index >= 0) return;
      e.preventDefault();
      e.stopPropagation();
      b.classList.remove('dragover');
      drag = null;
      edit(track, list, () => { track[list][i] = snapshot(); });
    });
    decorate(b, preset);
    row.appendChild(b);
  });

  row.appendChild(binEl);
}
