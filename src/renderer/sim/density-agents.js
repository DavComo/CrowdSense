// Agent-based crowd simulation — a Helbing-style social-force model,
// running in a WebAssembly module compiled from native/crowd_sim.c (see
// native/build.sh, docs/DENSITY_SIMULATION.md). This is the alternative
// to the continuum simulator in density.js: instead of one scalar
// density field, it tracks individual people directly, so the crowd
// naturally packs tighter right where people are actually pressing
// against each other (a stage barrier, a bottleneck) and thinner
// elsewhere — the person-scale texture the continuum model's single
// f(ρ) law can't produce, since it has no notion of "my immediate
// neighbor," only "the density here."
//
// Division of labor: this file (and masks.js before it) does the parts
// already solid in JS — rasterizing the venue, blocking zones, tunneling
// doors through walls, and solving the two static travel-time fields
// agents route by (via the same Fast Marching solver density.js uses).
// The WASM module only does what actually needs to be fast: the
// per-agent force computation and integration, every physics substep.
// Routing is deliberately solved once at free-flow speed, not re-solved
// against density every step the way the continuum model's does —
// congestion avoidance here comes from the social-force terms reacting
// to nearby agents directly, which is how a real social-force model
// works and is far cheaper than an eikonal re-solve every step.

import { computeSimulationDomain, solveEikonal, MAX_SIM_STEPS } from './density.js';
import { DEFAULT_THROUGHPUT } from './masks.js';
import createCrowdSimModule from './wasm/crowd_sim.js';

export const AGENT_PARAMS_DEFAULTS = {
  vMax: 1.34,       // m/s — free-flow desired speed, same as the continuum model's Weidmann v_max
  tau: 0.5,         // s — relaxation time toward the desired velocity (Helbing & Molnár 1995)
  agentRadius: 0.25, // m — roughly consistent with the continuum model's ρ_max=5.4/m² implied packing
  // Pairwise/wall repulsion (Helbing, Farkas & Vicsek 2000's A=2000N,
  // B=0.08m) expressed directly as an acceleration, not a force: this
  // sim has no separate per-agent mass term, so A here is already
  // "force ÷ typical 80kg pedestrian mass" (2000/80 = 25).
  socialA: 25,      // m/s²
  socialB: 0.08,    // m
  bodyStiffness: 240, // m/s² per meter of actual overlap, once two agents are closer than touching — keeps the crowd from visibly interpenetrating at very high density
};

const MAX_AGENTS_HARD_CAP = 20000; // matches native/crowd_sim.c's MAX_AGENTS

let modulePromise = null;
function loadModule() {
  if (!modulePromise) modulePromise = createCrowdSimModule();
  return modulePromise;
}

/**
 * Runs the agent-based crowd simulation. Same external shape as
 * runDensitySimulation in density.js (frames/times/domainMask/ledger/
 * metrics/warnings), so the density-viewer window and the rest of the
 * UI don't need to know which engine produced a given result.
 *
 * @param {object} venue
 * @param {number} cellSize world units per cell — only used for the
 *   routing fields and the output density grid's resolution here; agent
 *   positions themselves are continuous, not snapped to cells.
 * @param {number} maxPeople total people admitted before ingress ends
 * @param {number} dt seconds per *recorded* step (physics itself always
 *   substeps at a fixed, finer resolution internally — see
 *   native/crowd_sim.c's module note)
 * @param {number} totalTime seconds simulated
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<object>}
 */
export async function runAgentSimulation({
  venue, cellSize, maxPeople, dt, totalTime, onProgress, agentParams = AGENT_PARAMS_DEFAULTS,
}) {
  if (!(cellSize > 0)) throw new Error('cellSize must be a positive number.');
  if (!(maxPeople > 0)) throw new Error('Max people must be a positive number.');
  if (!(dt > 0)) throw new Error('Time step must be a positive number.');
  if (!(totalTime > 0)) throw new Error('Total time must be a positive number.');

  const numSteps = Math.min(MAX_SIM_STEPS, Math.ceil(totalTime / dt));
  if (Math.ceil(totalTime / dt) > MAX_SIM_STEPS) {
    throw new Error(`That many steps (${Math.ceil(totalTime / dt).toLocaleString()}) would take too long — raise the time step or lower the total time.`);
  }

  const { cols, rows, originX, originY, domainMask, attractingMask, attractionTargets } = computeSimulationDomain(venue, cellSize);
  const n = cols * rows;

  // An agent door is just a spawn/despawn point with a rate — unlike the
  // continuum model, there's no per-cell flux to keep under the
  // fundamental diagram's bound, so none of density.js's multi-cell
  // "door patch" spreading is needed here; the crowd itself, via the
  // social-force terms, is what actually limits how fast a doorway can
  // clear once people start queuing at it.
  const doors = [];
  const exitMask = new Uint8Array(n);
  for (const pt of venue.points) {
    if (pt.type !== 'entrance' && pt.type !== 'exit') continue;
    const ratePerSecond = (pt.throughput ?? DEFAULT_THROUGHPUT) / 60;
    if (ratePerSecond === 0) continue;
    const signed = pt.type === 'entrance' ? ratePerSecond : -ratePerSecond;
    doors.push({ x: pt.x, y: pt.y, rate: signed });
    if (signed < 0) {
      const col = Math.min(cols - 1, Math.max(0, Math.floor((pt.x - originX) / cellSize)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor((pt.y - originY) / cellSize)));
      exitMask[row * cols + col] = 1;
    }
  }
  const hasSource = doors.some((d) => d.rate > 0);
  const hasExit = doors.some((d) => d.rate < 0);
  if (maxPeople > MAX_AGENTS_HARD_CAP) {
    throw new Error(`Max people (${maxPeople.toLocaleString()}) exceeds this simulator's ${MAX_AGENTS_HARD_CAP.toLocaleString()}-agent limit — lower it or use the continuum simulator for a larger crowd.`);
  }

  const warnings = [];
  if (!hasSource) warnings.push('No entrances in this venue — nobody will enter.');
  if (!hasExit) warnings.push('No exits in this venue — people can enter but never leave.');
  const unsetThroughputCount = venue.points.filter(
    (p) => (p.type === 'entrance' || p.type === 'exit') && (p.throughput === null || p.throughput === undefined),
  ).length;
  if (unsetThroughputCount > 0) {
    warnings.push(`${unsetThroughputCount} entrance/exit point(s) have no throughput set — defaulting to ${DEFAULT_THROUGHPUT} people/minute each, which may not match the real door.`);
  }
  if (hasSource && !attractingMask.some(Boolean)) {
    warnings.push('No attraction zones — admitted people have nowhere to route to and will jam at the entrance.');
  } else if (hasSource && !attractionTargets.some(Boolean)) {
    warnings.push('No walkable floor borders an attraction zone — admitted people have nowhere to route to and will jam at the entrance.');
  }

  // Both routing fields are solved once, at a uniform free-flow speed —
  // see the module note at the top of this file for why this sim doesn't
  // re-solve them against density like the continuum one does.
  const freeFlowSpeed = new Float32Array(n).fill(agentParams.vMax);
  const phiAttract = Float32Array.from(solveEikonal(domainMask, attractionTargets, freeFlowSpeed, cols, rows, cellSize));
  const phiExit = Float32Array.from(solveEikonal(domainMask, exitMask, freeFlowSpeed, cols, rows, cellSize));

  const wasm = await loadModule();

  const walkablePtr = wasm._wasm_malloc(n);
  wasm.HEAPU8.set(domainMask, walkablePtr);
  const phiAttractPtr = wasm._wasm_malloc(n * 4);
  wasm.HEAPF32.set(phiAttract, phiAttractPtr >> 2);
  const phiExitPtr = wasm._wasm_malloc(n * 4);
  wasm.HEAPF32.set(phiExit, phiExitPtr >> 2);
  const doorFloats = new Float32Array(doors.length * 3);
  doors.forEach((d, i) => { doorFloats[i * 3] = d.x; doorFloats[i * 3 + 1] = d.y; doorFloats[i * 3 + 2] = d.rate; });
  const doorDataPtr = wasm._wasm_malloc(Math.max(1, doorFloats.byteLength));
  wasm.HEAPF32.set(doorFloats, doorDataPtr >> 2);
  const outGridPtr = wasm._wasm_malloc(n * 4);

  try {
    wasm._wasm_init(
      cols, rows, cellSize, originX, originY,
      walkablePtr, phiAttractPtr, phiExitPtr,
      doorDataPtr, doors.length,
      agentParams.vMax, agentParams.tau, agentParams.agentRadius,
      agentParams.socialA, agentParams.socialB, agentParams.bodyStiffness,
      maxPeople, 1 /* fixed seed — reproducible runs */,
    );

    const rasterize = () => {
      wasm._wasm_rasterize(outGridPtr);
      return new Float32Array(wasm.HEAPF32.buffer, outGridPtr, n).slice();
    };

    const targetFrameCount = 150;
    const recordEvery = Math.max(1, Math.floor(numSteps / targetFrameCount));
    const frames = [rasterize()];
    const times = [0];
    const peakDensity = new Float32Array(n);

    // Admission simply stops once maxPeople is reached — there's no
    // forced mass-evacuation switch afterward (a deliberate change: an
    // earlier version retargeted every agent to the exits the instant
    // admission hit its cap, which looked like the whole crowd abruptly
    // reversing course for no visible reason; people already inside now
    // just keep behaving normally, and an exit still works for whoever
    // actually ends up near one). Without that switch there's no defined
    // "evacuation start" moment, so phaseSwitchTime/t95 stay null.
    let lastYield = typeof performance !== 'undefined' ? performance.now() : Date.now();

    for (let step = 1; step <= numSteps; step++) {
      const t = step * dt;
      wasm._wasm_step(dt);

      if (step % recordEvery === 0 || step === numSteps) {
        const frame = rasterize();
        frames.push(frame);
        times.push(t);
        for (let i = 0; i < n; i++) if (frame[i] > peakDensity[i]) peakDensity[i] = frame[i];
      }

      if (onProgress && step % 20 === 0) onProgress(step / numSteps);
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastYield > 16) {
        lastYield = now;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    if (onProgress) onProgress(1);

    const admitted = wasm._wasm_get_admitted();
    const exited = wasm._wasm_get_exited();
    const stillInside = wasm._wasm_get_agent_count();
    // A discrete agent model has no continuum "clipped at ρ_max" concept
    // (an agent can't be silently compressed away) — conservation here
    // is exact by construction, so residual should read essentially 0.
    const ledgerResidual = admitted - stillInside - exited;

    return {
      cols, rows, cellSize, originX, originY, unit: venue.meta.unit,
      dt, totalTime, maxPeople,
      frames, times,
      domainMask,
      rhoMax: 5.4, // people/m² — same reference value as the continuum model, for a consistent colormap/legend scale
      phaseSwitchTime: null, // no forced evacuation phase — see the module note above
      ledger: { admitted, exited, clipped: 0, residual: ledgerResidual },
      metrics: { t95: null, peakDensity },
      warnings,
    };
  } finally {
    wasm._wasm_free(walkablePtr);
    wasm._wasm_free(phiAttractPtr);
    wasm._wasm_free(phiExitPtr);
    wasm._wasm_free(doorDataPtr);
    wasm._wasm_free(outGridPtr);
  }
}
