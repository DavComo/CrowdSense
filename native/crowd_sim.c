/* ---------------------------------------------------------------------
 * CrowdSense agent-based crowd simulator — a Helbing-style social-force
 * model (Helbing & Molnar, "Social force model for pedestrian dynamics",
 * 1995; Helbing, Farkas & Vicsek, "Simulating dynamical features of
 * escape panic", Nature 2000 — the same paper crowd_flow_design_v0.2.md's
 * Appendix A.3 cites its parameter table against). Compiled to
 * WebAssembly via Emscripten so it runs at native speed inside Electron
 * without a node-gyp/native-addon build step — see
 * docs/DENSITY_SIMULATION.md for why WASM specifically, and native/BUILD.md
 * for how to rebuild this file.
 *
 * Routing is deliberately *not* re-solved every step. This file receives
 * two travel-time fields (phiAttract, phiExit) precomputed by the JS
 * side's existing Fast Marching solver (src/renderer/sim/density.js),
 * solved once at free-flow speed. Each agent's desired direction is the
 * local downhill gradient of whichever field is active for the current
 * phase; actual congestion, jamming and lane-formation come from the
 * social-force terms below, not from re-solving the route field against
 * density every step — this is standard practice for social-force crowd
 * models (an agent reacts to the crowd around it directly, the same way
 * a real person does) and is dramatically cheaper than an eikonal
 * re-solve every step would be.
 *
 * Physical parameters below are the commonly-cited Helbing 2000 order of
 * magnitude (mass ~80kg, relaxation time 0.5s, pairwise repulsion
 * strength/range A=2000N, B=0.08m). That repulsion term is genuinely
 * stiff at that B, so integration always substeps internally at a fixed,
 * small physics dt (PHYSICS_SUBSTEP_DT) regardless of the caller's own
 * dt — the caller's dt controls *recording* granularity, not physics
 * stability; see wasm_step.
 * --------------------------------------------------------------------- */

#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#define MAX_AGENTS 20000
#define MAX_DOORS 256
#define PHYSICS_SUBSTEP_DT 0.02f    /* seconds — fine enough for the stiff social-force term to integrate stably regardless of the caller's own dt */
#define AGENT_INTERACTION_RADIUS 1.0f  /* meters — pairwise social force is negligible well before this, given B below */
#define NEIGHBOR_CELL_SIZE 1.0f     /* meters — spatial-hash bucket size for the O(n) neighbor search */
#define WALL_INTERACTION_RADIUS 0.6f   /* meters — how far out to search the grid for the nearest blocked cell */
#define HASH_BUCKETS 4096
#define DENSITY_KERNEL_SIGMA 0.6f      /* meters — density-map smoothing bandwidth, see wasm_rasterize's module note */

typedef struct {
  float x, y;   /* world coordinates, meters */
  float rate;   /* people/s at this door; positive = entrance, negative = exit */
} Door;

typedef struct {
  float x, y, vx, vy;
  float v0;     /* this agent's own desired free-flow speed (small per-agent jitter around vMax) */
} Agent;

/* ---- Simulation state (single instance — this module is not reentrant) ---- */
static int g_cols, g_rows;
static float g_cellSize, g_originX, g_originY;
static const unsigned char *g_walkable = NULL;  /* cols*rows, 1 = walkable — owned by the caller, not freed here */
static const float *g_phiAttract = NULL;         /* cols*rows travel-time field toward the attraction approach ring, +inf where unreachable */
static const float *g_phiExit = NULL;            /* cols*rows travel-time field toward the nearest exit */

static Door g_doors[MAX_DOORS];
static float g_doorSpawnCredit[MAX_DOORS];   /* entrances (4.6-style queue): fractional people banked toward the next spawn */
static float g_doorRemoveCredit[MAX_DOORS];  /* exits: fractional capacity banked toward the next removal */
static int g_numDoors = 0;

static Agent g_agents[MAX_AGENTS];
static int g_numAgents = 0;

static float g_vMax, g_tau, g_agentRadius, g_sfA, g_sfB, g_bodyK, g_maxPeople;
static float g_admitted = 0.0f, g_exited = 0.0f;
static int g_phase = 0; /* 0 = ingress, 1 = egress */
static float g_phaseSwitchTime = -1.0f;
static float g_simTime = 0.0f;

static unsigned int g_rngState = 1234567u;

/* xorshift32 — fast, deterministic (seeded from JS), no external dependency. */
static float frand(void) {
  g_rngState ^= g_rngState << 13;
  g_rngState ^= g_rngState >> 17;
  g_rngState ^= g_rngState << 5;
  return (float)(g_rngState & 0x00FFFFFFu) / (float)0x01000000u; /* [0,1) */
}

static int cellIndex(float x, float y, int *outCol, int *outRow) {
  int col = (int)floorf((x - g_originX) / g_cellSize);
  int row = (int)floorf((y - g_originY) / g_cellSize);
  if (col < 0 || col >= g_cols || row < 0 || row >= g_rows) return -1;
  *outCol = col;
  *outRow = row;
  return row * g_cols + col;
}

static int isWalkableWorld(float x, float y) {
  int col, row;
  int idx = cellIndex(x, y, &col, &row);
  if (idx < 0) return 0;
  return g_walkable[idx] != 0;
}

/* Gradient of a travel-time field at a world point, via central
 * differences on the grid cell it falls in — the same idea as
 * computeRouteDirection in density.js, evaluated on demand here since
 * agents move continuously rather than living at fixed cell centers. */
static void fieldDirection(const float *phi, float x, float y, float *outEx, float *outEy) {
  int col, row;
  int idx = cellIndex(x, y, &col, &row);
  if (idx < 0) { *outEx = 0.0f; *outEy = 0.0f; return; }
  float here = phi[idx];
  if (!(here < INFINITY)) { *outEx = 0.0f; *outEy = 0.0f; return; }

  int hasW = col > 0 && g_walkable[idx - 1] && phi[idx - 1] < INFINITY;
  int hasE = col < g_cols - 1 && g_walkable[idx + 1] && phi[idx + 1] < INFINITY;
  int hasN = row > 0 && g_walkable[idx - g_cols] && phi[idx - g_cols] < INFINITY;
  int hasS = row < g_rows - 1 && g_walkable[idx + g_cols] && phi[idx + g_cols] < INFINITY;

  float dphidx = 0.0f, dphidy = 0.0f;
  if (hasW && hasE) dphidx = (phi[idx + 1] - phi[idx - 1]) / (2.0f * g_cellSize);
  else if (hasE) dphidx = (phi[idx + 1] - here) / g_cellSize;
  else if (hasW) dphidx = (here - phi[idx - 1]) / g_cellSize;

  if (hasN && hasS) dphidy = (phi[idx + g_cols] - phi[idx - g_cols]) / (2.0f * g_cellSize);
  else if (hasS) dphidy = (phi[idx + g_cols] - here) / g_cellSize;
  else if (hasN) dphidy = (here - phi[idx - g_cols]) / g_cellSize;

  float mag = sqrtf(dphidx * dphidx + dphidy * dphidy);
  if (mag > 1e-9f) { *outEx = -dphidx / mag; *outEy = -dphidy / mag; return; }

  /* Flat neighborhood (a target cell, or a local plateau) — point toward
   * whichever open neighbor has the lowest φ, same rule density.js uses. */
  float best = here;
  float bx = 0.0f, by = 0.0f;
  if (hasW && phi[idx - 1] < best) { best = phi[idx - 1]; bx = -1.0f; by = 0.0f; }
  if (hasE && phi[idx + 1] < best) { best = phi[idx + 1]; bx = 1.0f; by = 0.0f; }
  if (hasN && phi[idx - g_cols] < best) { best = phi[idx - g_cols]; bx = 0.0f; by = -1.0f; }
  if (hasS && phi[idx + g_cols] < best) { best = phi[idx + g_cols]; bx = 0.0f; by = 1.0f; }
  *outEx = bx;
  *outEy = by;
}

/* ---- Spatial hash for the O(n) pairwise-neighbor search ---- */
static int g_bucketHead[HASH_BUCKETS];
static int g_bucketNext[MAX_AGENTS];

static unsigned int bucketHash(int bx, int by) {
  unsigned int h = (unsigned int)(bx * 73856093) ^ (unsigned int)(by * 19349663);
  return h % HASH_BUCKETS;
}

static void rebuildSpatialHash(void) {
  for (int b = 0; b < HASH_BUCKETS; b++) g_bucketHead[b] = -1;
  for (int i = 0; i < g_numAgents; i++) {
    int bx = (int)floorf(g_agents[i].x / NEIGHBOR_CELL_SIZE);
    int by = (int)floorf(g_agents[i].y / NEIGHBOR_CELL_SIZE);
    unsigned int h = bucketHash(bx, by);
    g_bucketNext[i] = g_bucketHead[h];
    g_bucketHead[h] = i;
  }
}

/* Nearest blocked-cell center within WALL_INTERACTION_RADIUS, for the
 * wall-repulsion term — short-range, so scanning nearby grid cells
 * directly (rather than a precomputed distance field) stays cheap. */
static int nearestWallPoint(float x, float y, float *outWx, float *outWy) {
  int col, row;
  if (cellIndex(x, y, &col, &row) < 0) return 0;
  int searchRadius = (int)ceilf(WALL_INTERACTION_RADIUS / g_cellSize) + 1;
  int minCol = col - searchRadius < 0 ? 0 : col - searchRadius;
  int maxCol = col + searchRadius >= g_cols ? g_cols - 1 : col + searchRadius;
  int minRow = row - searchRadius < 0 ? 0 : row - searchRadius;
  int maxRow = row + searchRadius >= g_rows ? g_rows - 1 : row + searchRadius;
  float bestDistSq = INFINITY;
  int found = 0;
  for (int r = minRow; r <= maxRow; r++) {
    for (int c = minCol; c <= maxCol; c++) {
      if (g_walkable[r * g_cols + c]) continue;
      float wx = g_originX + (c + 0.5f) * g_cellSize;
      float wy = g_originY + (r + 0.5f) * g_cellSize;
      float dx = x - wx, dy = y - wy;
      float d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) { bestDistSq = d2; *outWx = wx; *outWy = wy; found = 1; }
    }
  }
  return found;
}

EMSCRIPTEN_KEEPALIVE
int wasm_init(int cols, int rows, float cellSize, float originX, float originY,
              const unsigned char *walkable, const float *phiAttract, const float *phiExit,
              const float *doorData, int numDoors,
              float vMax, float tau, float agentRadius, float sfA, float sfB, float bodyK,
              float maxPeople, unsigned int seed) {
  g_cols = cols; g_rows = rows; g_cellSize = cellSize; g_originX = originX; g_originY = originY;
  g_walkable = walkable; g_phiAttract = phiAttract; g_phiExit = phiExit;

  g_numDoors = numDoors > MAX_DOORS ? MAX_DOORS : numDoors;
  for (int i = 0; i < g_numDoors; i++) {
    g_doors[i].x = doorData[i * 3 + 0];
    g_doors[i].y = doorData[i * 3 + 1];
    g_doors[i].rate = doorData[i * 3 + 2];
    g_doorSpawnCredit[i] = 0.0f;
    g_doorRemoveCredit[i] = 0.0f;
  }

  g_vMax = vMax; g_tau = tau; g_agentRadius = agentRadius;
  g_sfA = sfA; g_sfB = sfB; g_bodyK = bodyK;
  g_maxPeople = maxPeople;
  g_numAgents = 0;
  g_admitted = 0.0f; g_exited = 0.0f;
  g_phase = 0; g_phaseSwitchTime = -1.0f; g_simTime = 0.0f;
  g_rngState = seed ? seed : 1234567u;
  return 0;
}

static void removeAgentAt(int i) {
  g_agents[i] = g_agents[g_numAgents - 1];
  g_numAgents--;
}

static void spawnAgentAt(float x, float y, float ex, float ey) {
  if (g_numAgents >= MAX_AGENTS) return;
  Agent *a = &g_agents[g_numAgents++];
  a->v0 = g_vMax * (0.9f + frand() * 0.2f); /* +/-10% individual speed variation, same spirit as real pedestrians */
  a->x = x; a->y = y;
  float jitter = (frand() - 0.5f) * 0.1f;
  a->vx = ex * a->v0 + jitter;
  a->vy = ey * a->v0 + jitter;
}

/* Entrances (4.6-style admission queue): a fractional "credit" accrues at
 * this door's own rate every substep and spawns a whole agent once it
 * reaches 1 — so admission paces at exactly the requested rate on
 * average, never faster, and never drops anyone (unlike a per-cell
 * capacity check, an agent model has no "cell is full" failure mode to
 * queue against — the crowd itself is the queue). */
static void doSpawns(float dt) {
  for (int i = 0; i < g_numDoors; i++) {
    if (g_doors[i].rate <= 0.0f) continue;
    if (g_admitted >= g_maxPeople) continue;
    g_doorSpawnCredit[i] += g_doors[i].rate * dt;
    while (g_doorSpawnCredit[i] >= 1.0f && g_admitted < g_maxPeople && g_numAgents < MAX_AGENTS) {
      float ex, ey;
      fieldDirection(g_phiAttract, g_doors[i].x, g_doors[i].y, &ex, &ey);
      float sx = g_doors[i].x, sy = g_doors[i].y;
      for (int t = 0; t < 6; t++) {
        float ox = g_doors[i].x + (frand() - 0.5f) * g_agentRadius * 3.0f;
        float oy = g_doors[i].y + (frand() - 0.5f) * g_agentRadius * 3.0f;
        if (isWalkableWorld(ox, oy)) { sx = ox; sy = oy; break; }
      }
      spawnAgentAt(sx, sy, ex, ey);
      g_doorSpawnCredit[i] -= 1.0f;
      g_admitted += 1.0f;
    }
  }
}

/* Exits are rate-limited the same way — a door's own capacity, not
 * "instantly vanish on contact": credit accrues at |rate|, and only once
 * it reaches 1 does the nearest waiting agent actually leave. If nobody
 * is there yet the credit just carries over (queue, not drop). */
static void doRemovals(float dt) {
  for (int i = 0; i < g_numDoors; i++) {
    if (g_doors[i].rate >= 0.0f) continue;
    g_doorRemoveCredit[i] += (-g_doors[i].rate) * dt;
    float captureRadius = g_cellSize * 2.0f + g_agentRadius;
    float captureRadiusSq = captureRadius * captureRadius;
    while (g_doorRemoveCredit[i] >= 1.0f) {
      int best = -1;
      float bestD2 = captureRadiusSq;
      for (int a = 0; a < g_numAgents; a++) {
        float dx = g_agents[a].x - g_doors[i].x, dy = g_agents[a].y - g_doors[i].y;
        float d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = a; }
      }
      if (best < 0) break;
      removeAgentAt(best);
      g_exited += 1.0f;
      g_doorRemoveCredit[i] -= 1.0f;
    }
  }
}

static void integrateSubstep(float dt) {
  rebuildSpatialHash();
  /* Routing always targets the attraction — admission simply stops once
   * max people is reached (doSpawns), with no forced mass-evacuation
   * switch afterward. Someone already inside keeps behaving normally
   * (heading to/staying at the attraction) rather than every agent
   * abruptly reversing course toward the exit at once; exits still work
   * exactly as before for whoever actually ends up near one (doRemovals
   * runs unconditionally, independent of any phase). g_phase/phiExit are
   * kept as-is (always 0 / unused for routing) rather than ripped out,
   * so this stays a small, easily-reversible policy choice, not a
   * structural one. */
  const float *targetPhi = g_phiAttract;

  for (int i = 0; i < g_numAgents; i++) {
    Agent *a = &g_agents[i];
    float ex, ey;
    fieldDirection(targetPhi, a->x, a->y, &ex, &ey);
    int onTarget = (ex == 0.0f && ey == 0.0f);

    /* Driving force toward the desired velocity v0*e (Helbing's f_i^0),
     * or pure damping once "arrived" so an agent at its target
     * decelerates to a stop instead of coasting through it forever. */
    float desiredVx = onTarget ? 0.0f : ex * a->v0;
    float desiredVy = onTarget ? 0.0f : ey * a->v0;
    float fx = (desiredVx - a->vx) / g_tau;
    float fy = (desiredVy - a->vy) / g_tau;

    /* Pairwise social repulsion from nearby agents, via the spatial hash. */
    int cx = (int)floorf(a->x / NEIGHBOR_CELL_SIZE);
    int cy = (int)floorf(a->y / NEIGHBOR_CELL_SIZE);
    for (int by = -1; by <= 1; by++) {
      for (int bx = -1; bx <= 1; bx++) {
        int j = g_bucketHead[bucketHash(cx + bx, cy + by)];
        while (j >= 0) {
          if (j != i) {
            float dx = a->x - g_agents[j].x, dy = a->y - g_agents[j].y;
            float d = sqrtf(dx * dx + dy * dy);
            if (d > 1e-6f && d < AGENT_INTERACTION_RADIUS) {
              float nx = dx / d, ny = dy / d;
              /* Helbing's actual form is A*exp((r_ij - d_ij)/B) — repulsion
               * calibrated against how close two people are relative to
               * *touching* (r_ij = sum of their radii), not against raw
               * distance from d=0. Using exp(-d/B) instead (an earlier
               * version of this file did) means it only becomes
               * meaningful once two agents are almost perfectly
               * coincident — at d = r_ij itself (just touching), that
               * gives essentially zero force, so a crowd could compress
               * well inside people's actual body size with almost no
               * resistance, before the body-compression term below ever
               * caught up. That's what let density read several times
               * higher than physically possible for the configured
               * agent radius. */
              float overlap = 2.0f * g_agentRadius - d;
              float mag = g_sfA * expf(overlap / g_sfB);
              if (overlap > 0.0f) mag += g_bodyK * overlap; /* body compression once actually touching */
              fx += mag * nx;
              fy += mag * ny;
            }
          }
          j = g_bucketNext[j];
        }
      }
    }

    /* Wall repulsion, same functional form as the pairwise term. */
    float wx, wy;
    if (nearestWallPoint(a->x, a->y, &wx, &wy)) {
      float dx = a->x - wx, dy = a->y - wy;
      float d = sqrtf(dx * dx + dy * dy);
      if (d > 1e-6f) {
        float nx = dx / d, ny = dy / d;
        /* Same fix as the pairwise term above — contact distance here is
         * just the agent's own radius (the wall itself has none). */
        float overlap = g_agentRadius - d;
        float mag = g_sfA * expf(overlap / g_sfB);
        if (overlap > 0.0f) mag += g_bodyK * overlap;
        fx += mag * nx;
        fy += mag * ny;
      }
    }

    /* Semi-implicit (symplectic) Euler — velocity from the force first,
     * then position from the *new* velocity. Noticeably more stable than
     * plain explicit Euler for this spring-like force (crowd_flow_design
     * _v0.2.md's Appendix A.3 references the same symplectic-Euler
     * stability condition for exactly this reason). */
    a->vx += fx * dt;
    a->vy += fy * dt;
    float speed = sqrtf(a->vx * a->vx + a->vy * a->vy);
    float speedCap = a->v0 * 1.6f;
    if (speed > speedCap) {
      a->vx = a->vx / speed * speedCap;
      a->vy = a->vy / speed * speedCap;
    }

    float nx = a->x + a->vx * dt;
    float ny = a->y + a->vy * dt;
    if (isWalkableWorld(nx, a->y)) a->x = nx; else a->vx = 0.0f;
    if (isWalkableWorld(a->x, ny)) a->y = ny; else a->vy = 0.0f;
  }
}

/* Runs one *recorded* step of `dt` seconds, internally substepped at a
 * fixed small physics resolution (PHYSICS_SUBSTEP_DT) regardless of dt —
 * the stiff pairwise repulsion term needs that for stability, the same
 * reason real social-force implementations run at ~0.01-0.02s internally
 * even when reporting results at a coarser cadence. Returns the current
 * alive-agent count. */
EMSCRIPTEN_KEEPALIVE
int wasm_step(float dt) {
  int substeps = (int)ceilf(dt / PHYSICS_SUBSTEP_DT);
  if (substeps < 1) substeps = 1;
  float sub = dt / (float)substeps;
  for (int s = 0; s < substeps; s++) {
    doSpawns(sub);
    integrateSubstep(sub);
    doRemovals(sub);
  }
  g_simTime += dt;
  return g_numAgents;
}

/* Rasterizes current agent positions into a people/m² density grid
 * (cols*rows floats, caller-owned) via bilinear splatting — each agent
 * contributes exactly 1 person, spread across its 4 nearest cell centers
 * by distance, which reads far less "gravel-textured" than a plain
 * nearest-cell histogram would at typical crowd sizes, without
 * inventing a fake continuum field. */
EMSCRIPTEN_KEEPALIVE
void wasm_rasterize(float *outGrid) {
  memset(outGrid, 0, sizeof(float) * (size_t)g_cols * (size_t)g_rows);
  float cellArea = g_cellSize * g_cellSize;
  /* A Gaussian kernel, not a bilinear 4-cell splat: at typical grid
   * resolutions (~0.5m cells), splatting one person across only their 4
   * nearest cell centers concentrates that "1 person" into a fraction of
   * a square meter, so an isolated agent in an otherwise-sparse area
   * reads just as locally "hot" as one deep in a genuinely packed crowd
   * — the map ends up all quantization speckle, with no visible
   * region-to-region trend (this is what produced the "front of the
   * stage reads the same as the back" screenshot that prompted this
   * fix). A density map is inherently a *neighborhood* estimate — how
   * many people are around here — not a per-tiny-cell headcount, so
   * spread each agent's mass over a person-scale radius instead. Still
   * exactly conserves "1 person" per agent (weights renormalized to sum
   * to 1 over whichever candidate cells are walkable, same as the
   * bilinear version this replaces), and still never leaks into a wall
   * or blocked zone cell.
   *
   * DENSITY_KERNEL_SIGMA is a visualization bandwidth, not a physics
   * parameter — it does not affect where agents actually go, only how
   * their positions are aggregated into the density map read out here. */
  int windowCells = (int)ceilf(3.0f * DENSITY_KERNEL_SIGMA / g_cellSize) + 1;
  float twoSigmaSq = 2.0f * DENSITY_KERNEL_SIGMA * DENSITY_KERNEL_SIGMA;

  for (int i = 0; i < g_numAgents; i++) {
    float ax = g_agents[i].x, ay = g_agents[i].y;
    int c0, r0;
    if (cellIndex(ax, ay, &c0, &r0) < 0) continue; /* shouldn't happen — an agent is always in-domain */

    int minCol = c0 - windowCells, maxCol = c0 + windowCells;
    int minRow = r0 - windowCells, maxRow = r0 + windowCells;
    if (minCol < 0) minCol = 0;
    if (maxCol >= g_cols) maxCol = g_cols - 1;
    if (minRow < 0) minRow = 0;
    if (maxRow >= g_rows) maxRow = g_rows - 1;

    float totalWeight = 0.0f;
    for (int r = minRow; r <= maxRow; r++) {
      for (int c = minCol; c <= maxCol; c++) {
        int idx = r * g_cols + c;
        if (!g_walkable[idx]) continue;
        float cx = g_originX + (c + 0.5f) * g_cellSize;
        float cy = g_originY + (r + 0.5f) * g_cellSize;
        float dx = cx - ax, dy = cy - ay;
        totalWeight += expf(-(dx * dx + dy * dy) / twoSigmaSq);
      }
    }
    if (totalWeight <= 0.0f) continue; /* shouldn't happen: an agent's own cell is always walkable */

    for (int r = minRow; r <= maxRow; r++) {
      for (int c = minCol; c <= maxCol; c++) {
        int idx = r * g_cols + c;
        if (!g_walkable[idx]) continue;
        float cx = g_originX + (c + 0.5f) * g_cellSize;
        float cy = g_originY + (r + 0.5f) * g_cellSize;
        float dx = cx - ax, dy = cy - ay;
        float w = expf(-(dx * dx + dy * dy) / twoSigmaSq) / totalWeight;
        outGrid[idx] += w / cellArea;
      }
    }
  }
}

EMSCRIPTEN_KEEPALIVE int wasm_get_agent_count(void) { return g_numAgents; }
EMSCRIPTEN_KEEPALIVE float wasm_get_admitted(void) { return g_admitted; }
EMSCRIPTEN_KEEPALIVE float wasm_get_exited(void) { return g_exited; }
EMSCRIPTEN_KEEPALIVE int wasm_get_phase(void) { return g_phase; }
EMSCRIPTEN_KEEPALIVE float wasm_get_phase_switch_time(void) { return g_phaseSwitchTime; }

/* Explicit malloc/free exports — guaranteed present regardless of
 * Emscripten's default export list, so the JS side can always allocate
 * buffers in WASM linear memory to hand pointers into wasm_init. */
EMSCRIPTEN_KEEPALIVE void *wasm_malloc(int bytes) { return malloc((size_t)bytes); }
EMSCRIPTEN_KEEPALIVE void wasm_free(void *p) { free(p); }
