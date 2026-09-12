"""
unet.py -- the U-Net surrogate (design doc 6.2) and the gradient step through
it (6.3), for layouts drawn in the CrowdSense editor.

WHAT IT LEARNS. Input: the venue's maps for one layout + one scenario
(walkable, initial density, where people are headed, doors, attractor draw,
scenario one-hot). Output: the simulator's PEAK DENSITY MAP and sustained-
danger map (map head), plus the scenario's cost terms (scalar head from the
bottleneck). Loss = MSE(maps) + lambda * MSE(standardized scalars).

WHY A SOFT RASTERIZER. 6.3 needs x(z), a differentiable rasterization of the
plan vector into input channels. The design doc gets that for free because
its plan variables are gate/barrier toggles on fixed cells. Ours are
continuous positions and sizes, so `Raster` draws every movable element with
sigmoid edges (a rect is sigma((x-x0)/tau) * sigma((x1-x)/tau) * ...).
The gradient then lands on ~15 numbers, never on pixels -- the safety
property 6.3 relies on. The SAME rasterizer produces the training inputs
(at a sharp temperature), so train and search see identical channels.

Surrogate numbers are never shown; every candidate is re-simulated
(run_unet_pipeline.py). Hold-out R^2 on the cost gates whether the search
is trusted at all (6.4).
"""

import math
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import arena
import sim

DEVICE = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
SCENARIOS = ("circulation", "evacuation", "headliner")     # matches arena.training_suite
N_IN = 6 + len(SCENARIOS)
SCALARS = sim.SCALARS              # ("cost", "severity", "danger_frac", "max_P") -- canonical in sim.py
PAD_TO = 16                       # 4 U-Net levels


# --- differentiable rasterization ------------------------------------------
def _sig(x, tau):
    return torch.sigmoid(x / tau)


class Raster:
    """Draws the venue's input channels from a layout vector u, in torch.
    Fixed structure is baked once from the real raster; movable elements are
    drawn softly so d(channels)/du exists.

    `canon_hw`, when given (e.g. (64, 64)), forces a FIXED grid size shared
    by every venue -- design doc 6.2's input is x[4,64,64] specifically so
    ONE U-Net can train across many different room shapes; a per-venue grid
    size (the default here, sized to each venue's own extent) works for
    optimizing one venue but can't be pooled into a cross-venue dataset,
    since np.stack needs every sample the same shape. Larger venues get
    cropped to the canonical window (from the room's own origin); smaller
    ones get padded with not-walkable, same as before -- either way the
    real geometry is computed at the venue's true size first and then
    embedded into (or cropped into) the fixed canvas, never rescaled, so a
    wall is still exactly as many metres wide as it was drawn."""

    def __init__(self, venue, spec, dx=sim.DX, tau=0.15, canon_hw=None):
        self.venue, self.spec, self.dx, self.tau = venue, spec, dx, tau
        H, W = arena._grid_shape(spec.room, dx)
        self.H0, self.W0 = H, W
        if canon_hw:
            self.H, self.W = canon_hw
        else:
            self.H, self.W = math.ceil(H / PAD_TO) * PAD_TO, math.ceil(W / PAD_TO) * PAD_TO
        Hc, Wc = min(H, self.H), min(W, self.W)   # the overlap actually copied in
        rx0, ry0, _, _ = spec.room
        ys = ry0 + (torch.arange(self.H, dtype=torch.float32) + 0.5) * dx
        xs = rx0 + (torch.arange(self.W, dtype=torch.float32) + 0.5) * dx
        self.Y, self.X = torch.meshgrid(ys, xs, indexing="ij")       # [H, W] world coords
        self.dA = dx * dx

        # fixed structure, straight from the real raster (constant tensors),
        # computed at the venue's TRUE size (spec.room) so geometry is never
        # distorted, then embedded into the (possibly different-sized)
        # canonical canvas. Padding/cropped-away cells stay at their
        # zero-init, i.e. not-walkable -- there is no fake open floor beyond
        # the real venue's own walls.
        movable_none = {}
        geo = arena._effective_geo(venue, movable_none)
        fixed_venue = {**venue,
                       "walls": [w for w in venue["walls"] if not w.get("movable", False)],
                       "zones": [z for z in venue["zones"] if not z.get("movable", True)]}
        obstacle = arena._build_obstacle(fixed_venue, geo, spec.room, cell=dx)
        vg = sim.Venue(fixed_venue, {}, spec.room, dx=dx)   # carves doors, finds fixed attractors
        base = torch.zeros(self.H, self.W)
        base[:Hc, :Wc] = torch.from_numpy((~obstacle).astype(np.float32))[:Hc, :Wc]
        base[:Hc, :Wc] *= torch.from_numpy(vg.walkable.astype(np.float32))[:Hc, :Wc]  # doors carved
        self.base_walkable = base
        self.in_grid = torch.zeros(self.H, self.W); self.in_grid[:Hc, :Wc] = 1.0

        def _in_canon(r, c):
            return 0 <= r < self.H and 0 <= c < self.W

        ent = torch.zeros(self.H, self.W); ex = torch.zeros(self.H, self.W)
        for e in vg.entrances:
            for (r, c) in e["cells"]:
                if _in_canon(r, c):
                    ent[r, c] += e["rate"] / (len(e["cells"]) * self.dA)
        for e in vg.exits:
            for (r, c) in e["cells"]:
                if _in_canon(r, c):
                    ex[r, c] = 1.0
        self.entrance_rate = ent / max(float(ent.max()), 1e-6)
        self.exit_mask = ex
        stage = torch.zeros(self.H, self.W)
        for a in vg.attractors:
            if a["kind"] == "stage":
                for (r, c) in a["cells"]:
                    if _in_canon(r, c):
                        stage[r, c] = 1.0
        self.stage_ring = stage

        # per-entry constants
        self.entries = spec.entries
        self.draw_max = max([float(z.get("capacity") or 1) for z in venue["zones"]] + [1.0])
        self.zone_meta = {z["id"]: z for z in venue["zones"]}

    # -- shape masks, all differentiable in their parameters --
    def rect(self, x, y, w, h):
        t = self.tau
        return _sig(self.X - x, t) * _sig(x + w - self.X, t) * _sig(self.Y - y, t) * _sig(y + h - self.Y, t)

    def circle(self, cx, cy, r):
        d = torch.sqrt((self.X - cx) ** 2 + (self.Y - cy) ** 2 + 1e-9)
        return _sig(r - d, self.tau)

    def segment(self, x1, y1, x2, y2, thick):
        vx, vy = x2 - x1, y2 - y1
        L2 = vx * vx + vy * vy + 1e-9
        t = torch.clamp(((self.X - x1) * vx + (self.Y - y1) * vy) / L2, 0.0, 1.0)
        px, py = x1 + t * vx, y1 + t * vy
        d = torch.sqrt((self.X - px) ** 2 + (self.Y - py) ** 2 + 1e-9)
        return _sig(thick / 2 + self.dx * 0.5 - d, self.tau)

    def polyline(self, pts, thick):
        m = torch.zeros_like(self.X)
        for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:]):
            m = torch.maximum(m, self.segment(x1, y1, x2, y2, thick))
        return m

    # -- decode u -> shapes, mirroring arena._decode_entry in torch --
    def decode(self, u):
        bx0, by0, bx1, by1 = self.spec.bounds
        out = {}
        for e in self.entries:
            uv = u[e["off"]: e["off"] + e["n"]]
            g0, ext, shape = e["geo0"], e["extendable"], e["geo0"]["shape"]
            if shape == "rect":
                if ext:
                    w_lo, w_hi, h_lo, h_hi = arena._rect_size_bounds(g0, self.spec.bounds)
                    w = w_lo + uv[0] * (w_hi - w_lo); h = h_lo + uv[1] * (h_hi - h_lo)
                    x = bx0 + uv[2] * torch.clamp(bx1 - w - bx0, min=0.0)
                    y = by0 + uv[3] * torch.clamp(by1 - h - by0, min=0.0)
                else:
                    w, h = torch.tensor(g0["w"]), torch.tensor(g0["h"])
                    x = bx0 + uv[0] * max(bx1 - g0["w"] - bx0, 0.0)
                    y = by0 + uv[1] * max(by1 - g0["h"] - by0, 0.0)
                out[e["id"]] = ("rect", (x, y, w, h))
            elif shape == "circle":
                if ext:
                    r_lo, r_hi = arena._circle_r_bounds(g0, self.spec.bounds)
                    r = r_lo + uv[0] * (r_hi - r_lo); i = 1
                else:
                    r = torch.tensor(g0["r"]); i = 0
                cx = bx0 + r + uv[i] * torch.clamp(bx1 - r - (bx0 + r), min=0.0)
                cy = by0 + r + uv[i + 1] * torch.clamp(by1 - r - (by0 + r), min=0.0)
                out[e["id"]] = ("circle", (cx, cy, r))
            elif shape in ("line", "polygon"):
                pts0 = g0["points"]
                x0, y0, x1, y1 = arena._bbox_of_points(pts0)
                ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
                i = 0; s = torch.tensor(1.0)
                if ext:
                    s = 0.6 + uv[0] * 1.0; i = 1
                w, h = (x1 - x0) * s, (y1 - y0) * s
                sx0, sy0 = ccx - w / 2, ccy - h / 2
                dx_ = (bx0 - sx0) + uv[i] * torch.clamp((bx1 - w) - bx0, min=0.0)
                dy_ = (by0 - sy0) + uv[i + 1] * torch.clamp((by1 - h) - by0, min=0.0)
                pts = [(ccx + (p["x"] - ccx) * s + dx_, ccy + (p["y"] - ccy) * s + dy_) for p in pts0]
                out[e["id"]] = (shape, (pts, g0.get("thickness", 0.25)))
            elif shape == "point":
                out[e["id"]] = ("point", (bx0 + uv[0] * (bx1 - bx0), by0 + uv[1] * (by1 - by0)))
        return out

    def mask(self, kind, params):
        if kind == "rect":
            return self.rect(*params)
        if kind == "circle":
            return self.circle(*params)
        if kind in ("line", "polygon"):
            pts, thick = params
            if kind == "polygon":
                pts = pts + [pts[0]]
            return self.polyline(pts, thick)
        return torch.zeros_like(self.X)

    def channels(self, u, scenario):
        """u: torch [dim] in [0,1] (may require grad). Returns [N_IN, H, W]."""
        shapes = self.decode(u)
        walk = self.base_walkable.clone()
        draw = torch.zeros_like(self.X)
        zone_masks = {}
        for e in self.entries:
            kind, params = shapes[e["id"]]
            m = self.mask(kind, params)
            if e["kind"] == "wall":
                walk = walk * (1 - m)
            elif e["kind"] == "zone":
                z = self.zone_meta[e["id"]]
                if arena._classify_zone(z) == "obstacle":
                    walk = walk * (1 - m)
                elif arena._classify_zone(z) == "populated":
                    zone_masks[e["id"]] = m
                    draw = torch.maximum(draw, m * float(z.get("capacity") or 1) / self.draw_max)
        # fixed populated zones (locked by the designer) still count
        for z in self.venue["zones"]:
            if z["id"] not in zone_masks and arena._classify_zone(z) == "populated":
                g = arena._zone_geo(z)
                m = self.mask(g["shape"], (g["x"], g["y"], g["w"], g["h"]) if g["shape"] == "rect"
                              else (g["cx"], g["cy"], g["r"]) if g["shape"] == "circle"
                              else ([(p["x"], p["y"]) for p in g["points"]], 0.0))
                zone_masks[z["id"]] = m
                draw = torch.maximum(draw, m * float(z.get("capacity") or 1) / self.draw_max)

        # initial density: each populated zone's capacity spread over its
        # (soft) walkable footprint -- the differentiable stand-in for
        # sim._spread(); the U-Net learns the real thing from the targets.
        rho0 = torch.zeros_like(self.X)
        if scenario != "ingress":
            for zid, m in zone_masks.items():
                cap = float(self.zone_meta[zid].get("capacity") or 0)
                foot = m * walk
                rho0 = rho0 + cap * foot / (foot.sum() * self.dA + 1e-6)
        rho0 = torch.clamp(rho0, max=sim.RHO_MAX) / sim.RHO_MAX

        if scenario == "evacuation":
            target = self.exit_mask
        elif scenario == "headliner":
            target = self.stage_ring
        else:
            target = torch.zeros_like(self.X)
            for m in zone_masks.values():
                target = torch.maximum(target, m)
        onehot = [torch.full_like(self.X, 1.0 if s == scenario else 0.0) for s in SCENARIOS]
        ch = torch.stack([walk * self.in_grid, rho0, target, self.entrance_rate, self.exit_mask, draw] + onehot)
        return ch


# --- the network (6.2: 4 levels, base 32, ~2M params) ----------------------
def _block(cin, cout):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
                         nn.Conv2d(cout, cout, 3, padding=1), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class UNet(nn.Module):
    def __init__(self, n_in=N_IN, n_map=2, n_scalar=len(SCALARS), base=16):
        # base 16 -> ~2M params, the size 6.2 asks for. base 32 gives 7.8M,
        # which badly overfits the ~1.8k samples one night of simulation buys.
        super().__init__()
        c = [base, base * 2, base * 4, base * 8]
        self.enc = nn.ModuleList([_block(n_in, c[0]), _block(c[0], c[1]), _block(c[1], c[2]), _block(c[2], c[3])])
        self.pool = nn.MaxPool2d(2)
        self.bott = _block(c[3], c[3] * 2)
        self.up = nn.ModuleList([nn.ConvTranspose2d(c[3] * 2, c[3], 2, stride=2),
                                 nn.ConvTranspose2d(c[3], c[2], 2, stride=2),
                                 nn.ConvTranspose2d(c[2], c[1], 2, stride=2),
                                 nn.ConvTranspose2d(c[1], c[0], 2, stride=2)])
        self.dec = nn.ModuleList([_block(c[3] * 2, c[3]), _block(c[2] * 2, c[2]),
                                  _block(c[1] * 2, c[1]), _block(c[0] * 2, c[0])])
        self.map_head = nn.Conv2d(c[0], n_map, 1)
        self.scalar_head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(),
                                         nn.Linear(c[3] * 2, 128), nn.ReLU(inplace=True), nn.Linear(128, n_scalar))

    def forward(self, x):
        skips = []
        for enc in self.enc:
            x = enc(x); skips.append(x); x = self.pool(x)
        x = self.bott(x)
        scal = self.scalar_head(x)
        for up, dec, s in zip(self.up, self.dec, reversed(skips)):
            x = dec(torch.cat([up(x), s], dim=1))
        maps = self.map_head(x)
        return maps, scal


# --- training ---------------------------------------------------------------
class Surrogate:
    """Wraps the net with the standardization it was trained with."""

    def __init__(self, raster, net, y_mean, y_std):
        self.raster, self.net = raster, net
        self.y_mean = torch.tensor(y_mean, dtype=torch.float32, device=DEVICE)
        self.y_std = torch.tensor(y_std, dtype=torch.float32, device=DEVICE)

    def predict(self, u, scenario):
        """u: numpy [dim]. Returns (peak_rho [H,W], danger [H,W], scalars dict)."""
        self.net.eval()
        with torch.no_grad():
            x = self.raster.channels(torch.tensor(u, dtype=torch.float32), scenario)[None].to(DEVICE)
            maps, scal = self.net(x)
        scal = (scal[0] * self.y_std + self.y_mean).cpu().numpy()
        H0, W0 = self.raster.H0, self.raster.W0
        peak = (maps[0, 0, :H0, :W0].clamp(0, 1) * sim.RHO_MAX).cpu().numpy()
        danger = torch.sigmoid(maps[0, 1, :H0, :W0]).cpu().numpy()
        return peak, danger, dict(zip(SCALARS, scal.tolist()))

    def surrogate_cost(self, u_t, scenario):
        """Differentiable: the cost the 6.3 descent minimizes.

        Used to be recomputed from the U-Net's predicted PEAK-density map
        (a spatial-only softplus penalty) so the search descended through
        density pixels directly. That stopped being correct the moment
        sim.appraise()'s `cost` became TIME-integrated (see its own
        docstring: a peak map cannot distinguish a cell that was crowded
        for 3s from one crowded for 200s) -- a single static map structurally
        cannot represent that, so recomputing "cost" from the map here would
        silently keep the search optimizing the OLD, superseded objective
        while everything else (training labels, verification) moved on to
        the new one. The scalar head already predicts the real (time-aware)
        `cost` directly -- trained on sim.appraise()'s actual output, not a
        map-based proxy -- so the search follows that instead."""
        x = self.raster.channels(u_t, scenario)[None].to(DEVICE)
        _, scal = self.net(x)
        return scal[0, SCALARS.index("cost")] * self.y_std[SCALARS.index("cost")] + self.y_mean[SCALARS.index("cost")]


def train(raster, X, Y_maps, Y_scal, epochs=20, lr=1e-3, lam=1.0, batch=16, holdout=0.15, seed=0, log=print):
    """X: [N, N_IN, H, W] float32; Y_maps: [N, 2, H, W]; Y_scal: [N, len(SCALARS)]."""
    torch.manual_seed(seed)
    N = len(X)
    perm = np.random.default_rng(seed).permutation(N)
    n_test = max(int(N * holdout), 8)
    te, tr = perm[:n_test], perm[n_test:]
    y_mean, y_std = Y_scal[tr].mean(0), Y_scal[tr].std(0) + 1e-6

    Xt = torch.tensor(X); Ym = torch.tensor(Y_maps); Ys = torch.tensor((Y_scal - y_mean) / y_std, dtype=torch.float32)
    net = UNet().to(DEVICE)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    n_params = sum(p.numel() for p in net.parameters())
    log(f"  U-Net: {n_params/1e6:.2f}M params, {len(tr)} train / {len(te)} held-out, device {DEVICE}")

    for ep in range(epochs):
        net.train(); tot = 0.0
        order = np.random.default_rng(seed + ep).permutation(tr)
        for i in range(0, len(order), batch):
            idx = order[i:i + batch]
            xb, mb, sb = Xt[idx].to(DEVICE), Ym[idx].to(DEVICE), Ys[idx].to(DEVICE)
            maps, scal = net(xb)
            loss_map = F.mse_loss(maps[:, 0], mb[:, 0]) + F.binary_cross_entropy_with_logits(maps[:, 1], mb[:, 1])
            loss = loss_map + lam * F.mse_loss(scal, sb)
            opt.zero_grad(); loss.backward(); opt.step()
            tot += float(loss) * len(idx)
        sched.step()
        if ep % 5 == 0 or ep == epochs - 1:
            log(f"    epoch {ep:3d}   train loss {tot/len(tr):.4f}")

    # hold-out: R^2 on the cost (the 6.4 guardrail) and on the peak map
    net.eval()
    with torch.no_grad():
        maps, scal = net(Xt[te].to(DEVICE))
        pred = (scal.cpu().numpy() * y_std + y_mean)
        pm = maps[:, 0].cpu().numpy()
    truth = Y_scal[te]
    r2 = {}
    for j, name in enumerate(SCALARS):
        ss_res = float(((pred[:, j] - truth[:, j]) ** 2).sum()); ss_tot = float(((truth[:, j] - truth[:, j].mean()) ** 2).sum())
        r2[name] = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    tm = Y_maps[te, 0]
    r2["peak_map"] = 1 - float(((pm - tm) ** 2).sum()) / max(float(((tm - tm.mean()) ** 2).sum()), 1e-9)
    rank = float(np.corrcoef(np.argsort(np.argsort(pred[:, 0])), np.argsort(np.argsort(truth[:, 0])))[0, 1])
    return Surrogate(raster, net, y_mean, y_std), r2, rank


# --- 6.3: gradient through the frozen surrogate ------------------------------
def gradient_search(surr, u0, scenarios, weights, steps=200, lr=0.02):
    """Projected gradient descent on sum_s w_s * surrogate_cost(u, s), with u
    clamped to [0,1]. ~15 numbers, so there is no way to produce wall soup."""
    surr.net.eval()
    for p in surr.net.parameters():
        p.requires_grad_(False)
    u = torch.tensor(np.clip(u0, 0, 1), dtype=torch.float32, requires_grad=True)
    opt = torch.optim.Adam([u], lr=lr)
    for _ in range(steps):
        opt.zero_grad()
        J = sum(w * surr.surrogate_cost(u, s) for s, w in zip(scenarios, weights)) / sum(weights)
        J.backward()
        opt.step()
        with torch.no_grad():
            u.clamp_(0.0, 1.0)
    with torch.no_grad():
        J = float(sum(w * surr.surrogate_cost(u, s) for s, w in zip(scenarios, weights)) / sum(weights))
    return u.detach().numpy(), J


def surrogate_objective(surr, u, scenarios, weights):
    with torch.no_grad():
        u_t = torch.tensor(u, dtype=torch.float32)
        return float(sum(w * surr.surrogate_cost(u_t, s) for s, w in zip(scenarios, weights)) / sum(weights))
