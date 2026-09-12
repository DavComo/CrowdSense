// Progress window for "Optimize Layout…" — kicks off the optimizer
// itself (unlike the mask/density viewers, which just display a result
// they're handed), shows a progress bar and live log as it runs, then
// offers to load the winning layout into the editor and/or run a
// side-by-side density comparison against the original.

import { runDensitySimulation } from './sim/density.js';
import { runAgentSimulation } from './sim/density-agents.js';

const subtitleEl = document.getElementById('subtitle');
const progressFillEl = document.getElementById('progress-fill');
const stageTextEl = document.getElementById('stage-text');
const elapsedEl = document.getElementById('elapsed');
const logEl = document.getElementById('log');
const errorBoxEl = document.getElementById('error-box');
const resultEl = document.getElementById('result');
const resultHeadlineEl = document.getElementById('result-headline');
const breakdownBodyEl = document.getElementById('breakdown-body');
const btnApply = document.getElementById('btn-apply');
const btnCompare = document.getElementById('btn-compare');
const compareStatusEl = document.getElementById('compare-status');

let current = null; // { venue, engine, cellSize, maxPeople, dt, totalTime, title }
let startedAt = null;
let elapsedTimer = null;

// Coarse, stage-boundary progress (the optimizer only reports progress at
// stage transitions, not per-sample) — weighted by where wall-clock time
// actually goes in practice (training data generation dominates; see
// docs/OPTIMIZER.md's measured timing).
const STAGE_PERCENT = {
  loaded: 2,
  training_data_start: 5,
  training_data_done: 80,
  surrogate_training_start: 82,
  surrogate_training_done: 85,
  search_start: 87,
  verify_start: 90,
  verify_done: 98,
  done: 100,
};

const STAGE_TEXT = {
  loaded: (p) => `Loaded venue (${p.movable_elements} movable element${p.movable_elements === 1 ? '' : 's'})…`,
  training_data_start: (p) => `Generating training data (${p.n_train} simulator runs on ${p.n_workers} workers)…`,
  training_data_done: (p) => `Training data ready in ${p.seconds.toFixed(0)}s (cost range ${p.cost_min.toFixed(3)}–${p.cost_max.toFixed(3)})…`,
  surrogate_training_start: () => 'Training surrogate model…',
  surrogate_training_done: (p) => `Surrogate trained (R²=${p.r2.toFixed(2)}${p.trusted ? '' : ' — not yet trusted, falling back to the best sampled layout if needed'})…`,
  search_start: () => 'Searching for a better layout on the surrogate…',
  verify_start: (p) => `Re-simulating ${p.n_candidates} candidates on the real simulator…`,
  verify_done: (p) => `Verified in ${p.seconds.toFixed(0)}s…`,
  done: () => 'Finishing up…',
};

function setProgress(pct, text) {
  progressFillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (text) stageTextEl.textContent = text;
}

function appendLog(line, isErr) {
  const div = document.createElement('div');
  if (isErr) div.className = 'err';
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function startElapsedTimer() {
  startedAt = performance.now();
  elapsedTimer = setInterval(() => {
    elapsedEl.textContent = `${((performance.now() - startedAt) / 1000).toFixed(0)}s elapsed`;
  }, 500);
}
function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function weightedCost(scenarios) {
  const totalWeight = scenarios.reduce((s, r) => s + (r.weight || 1), 0) || 1;
  return scenarios.reduce((s, r) => s + (r.weight || 1) * r.cost, 0) / totalWeight;
}

async function run(payload) {
  current = payload;
  const engineLabel = payload.engine === 'continuum' ? 'Continuum' : 'Agent-based';
  const samplesLabel = payload.trainSamples ? ` · ${payload.trainSamples} training samples` : '';
  subtitleEl.textContent = `${payload.venue.meta.name} · ${engineLabel} engine${samplesLabel}`;
  startElapsedTimer();

  window.optimizerViewer.onOptimizerProgress((p) => {
    // The two batch stages (training-data generation, the final
    // re-simulation) report their own running "done/total" as each sample
    // completes, rather than only a start/end marker — interpolated here
    // into that stage's slice of the bar, so the bar actually moves
    // through the ~75-point span training data alone takes up instead of
    // sitting still for the whole run and then jumping.
    if (p.stage === 'training_data_progress' || p.stage === 'verify_progress') {
      const [startStage, endStage] = p.stage === 'training_data_progress'
        ? ['training_data_start', 'training_data_done']
        : ['verify_start', 'verify_done'];
      const frac = p.total ? p.done / p.total : 0;
      const pct = STAGE_PERCENT[startStage] + frac * (STAGE_PERCENT[endStage] - STAGE_PERCENT[startStage]);
      const verb = p.stage === 'training_data_progress' ? 'Generating training data' : 'Re-simulating candidates on the real simulator';
      setProgress(pct, `${verb}… ${p.done}/${p.total} (${Math.round(frac * 100)}%)…`);
      return;
    }
    const pct = STAGE_PERCENT[p.stage];
    const toText = STAGE_TEXT[p.stage];
    setProgress(pct ?? 0, toText ? toText(p) : p.stage);
  });
  window.optimizerViewer.onOptimizerLog(({ line, isErr }) => appendLog(line, isErr));

  try {
    const { result } = await window.optimizerViewer.runOptimizer(payload.venue, payload.trainSamples);
    stopElapsedTimer();
    setProgress(100, 'Done.');

    const sim = result.simulation;
    const costBefore = weightedCost(sim.scenarios_before);
    const costAfter = weightedCost(sim.scenarios_after);
    const improvedPct = costBefore > 0 ? (100 * (costBefore - costAfter)) / costBefore : 0;
    const improved = improvedPct > 0.5;

    resultHeadlineEl.className = improved ? 'good' : 'bad';
    resultHeadlineEl.textContent = improved
      ? `Improved — excess-density cost down ${improvedPct.toFixed(1)}% (${costBefore.toFixed(4)} → ${costAfter.toFixed(4)})`
      : `No improvement found (cost ${costBefore.toFixed(4)} → ${costAfter.toFixed(4)}) — the original layout was kept.`;

    breakdownBodyEl.innerHTML = '';
    sim.scenarios_before.forEach((b, i) => {
      const a = sim.scenarios_after[i];
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${b.label}</td><td>${b.cost.toFixed(4)}</td><td>${a.cost.toFixed(4)}</td>`;
      breakdownBodyEl.appendChild(tr);
    });

    btnApply.disabled = !improved;
    resultEl.style.display = 'flex';

    btnApply.addEventListener('click', async () => {
      await window.optimizerViewer.applyVenueToEditor(sim.optimized_venue);
      btnApply.textContent = 'Loaded ✓';
      btnApply.disabled = true;
    });

    btnCompare.addEventListener('click', () => runComparison(payload, sim.optimized_venue));
  } catch (err) {
    stopElapsedTimer();
    setProgress(100, 'Failed.');
    errorBoxEl.style.display = 'block';
    errorBoxEl.textContent = String((err && err.message) || err);
  }
}

/** Runs the same density engine/settings the main window's Crowd
 * Simulation panel currently has selected, once on the original venue
 * and once on the optimized one, then opens the density-viewer window in
 * side-by-side comparison mode. */
async function runComparison(payload, optimizedVenue) {
  btnCompare.disabled = true;
  compareStatusEl.style.display = 'block';
  const runSimulation = payload.engine === 'continuum' ? runDensitySimulation : runAgentSimulation;

  try {
    compareStatusEl.textContent = 'Simulating original layout…';
    const before = await runSimulation({
      venue: payload.venue,
      cellSize: payload.cellSize,
      maxPeople: payload.maxPeople,
      dt: payload.dt,
      totalTime: payload.totalTime,
      onProgress: (frac) => { compareStatusEl.textContent = `Simulating original layout… ${Math.round(frac * 100)}%`; },
    });

    compareStatusEl.textContent = 'Simulating optimized layout…';
    const after = await runSimulation({
      venue: optimizedVenue,
      cellSize: payload.cellSize,
      maxPeople: payload.maxPeople,
      dt: payload.dt,
      totalTime: payload.totalTime,
      onProgress: (frac) => { compareStatusEl.textContent = `Simulating optimized layout… ${Math.round(frac * 100)}%`; },
    });

    compareStatusEl.textContent = 'Opening comparison…';
    // Each pane needs its OWN venue — the optimizer may have moved,
    // resized, or removed elements, so "before" and "after" can draw
    // different designer overlays even though they share a grid/timeline.
    await window.optimizerViewer.openDensityViewer({
      compare: {
        before: { ...before, venue: payload.venue },
        after: { ...after, venue: optimizedVenue },
      },
      title: `${payload.venue.meta.name} — Before / After`,
    });
    compareStatusEl.textContent = 'Comparison opened in a separate window.';
  } catch (err) {
    compareStatusEl.textContent = `Comparison failed: ${String((err && err.message) || err)}`;
  } finally {
    btnCompare.disabled = false;
  }
}

window.optimizerViewer.onData(run);
