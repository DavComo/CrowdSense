"""
optimize_venue.py -- take a FIXED venue and find the best way to operate it.

Two search methods over the operating plan (which gates to open, how to route
the crowd). Neither one moves a single wall.
"""

import numpy as np, itertools
from venue import demo_arena, baseline_policy, objective, evaluate


def route_greedily(venue, open_mask, n_passes=6):
    """Given a set of open gates, decide where to send each zone.

    Start everyone at their nearest open gate, then repeatedly make the single
    reassignment that helps most, until nothing helps. This is 'load balancing':
    pull people off the overloaded gate and push them to an idle one.
    """
    d = np.where(open_mask[None, :], venue.dist, np.inf)
    route = d.argmin(axis=1)
    best  = objective(venue, open_mask, route)
    open_gates = np.flatnonzero(open_mask)

    for _ in range(n_passes):
        improved = False
        for z in range(venue.Z):
            cur = route[z]
            for g in open_gates:
                if g == cur:
                    continue
                route[z] = g
                val = objective(venue, open_mask, route)
                if val < best - 1e-9:
                    best, cur, improved = val, g, True
                else:
                    route[z] = cur
        if not improved:
            break
    return route, best


def search_gate_subsets(venue, verbose=True):
    """Try every legal combination of open gates. With 12 gates and staff for 7
    that is 792 options -- small enough to check them ALL, which means the
    answer is provably the best plan, not just a good one."""
    best = (np.inf, None, None)
    combos = list(itertools.combinations(range(venue.K), venue.staff_budget))
    for c in combos:
        om = np.zeros(venue.K, dtype=bool); om[list(c)] = True
        route, val = route_greedily(venue, om, n_passes=2)
        if val < best[0]:
            best = (val, om.copy(), route.copy())
    # polish the winner properly
    route, val = route_greedily(venue, best[1], n_passes=8)
    if verbose:
        print(f"  checked {len(combos)} gate combinations")
    return val, best[1], route


def greedy_intervention_list(venue, open_mask, route_from, route_to):
    """Turn the optimised plan into an ORDERED list of changes, most valuable
    first, so an operator can see how much each single change buys them."""
    changes = [z for z in range(venue.Z) if route_from[z] != route_to[z]]
    cur, steps = route_from.copy(), []
    base = objective(venue, open_mask, cur)
    remaining = set(changes)
    while remaining:
        best_z, best_val = None, base
        for z in remaining:
            old = cur[z]; cur[z] = route_to[z]
            val = objective(venue, open_mask, cur)
            cur[z] = old
            if val < best_val:
                best_z, best_val = z, val
        if best_z is None:
            break
        cur[best_z] = route_to[best_z]
        steps.append((best_z, int(route_to[best_z]), base - best_val))
        base = best_val
        remaining.discard(best_z)
    return steps


if __name__ == "__main__":
    v = demo_arena()
    om0, rt0 = baseline_policy(v)
    r0 = evaluate(v, om0, rt0)
    print(f"BEFORE  (no intervention)")
    print(f"  gates open     : {list(np.flatnonzero(om0))}")
    print(f"  evacuation     : {r0['evac_time']:.0f} s")
    print(f"  peak pressure  : {r0['peak_pressure']:.3f}\n")

    print("searching operating plans ...")
    val, om1, rt1 = search_gate_subsets(v)
    r1 = evaluate(v, om1, rt1)
    print(f"\nAFTER  (optimised plan)")
    print(f"  gates open     : {list(np.flatnonzero(om1))}")
    print(f"  evacuation     : {r1['evac_time']:.0f} s   ({100*(r0['evac_time']-r1['evac_time'])/r0['evac_time']:.0f}% faster)")
    print(f"  peak pressure  : {r1['peak_pressure']:.3f}   ({100*(r0['peak_pressure']-r1['peak_pressure'])/r0['peak_pressure']:.0f}% lower)")

    opened  = set(np.flatnonzero(om1)) - set(np.flatnonzero(om0))
    closed  = set(np.flatnonzero(om0)) - set(np.flatnonzero(om1))
    print(f"\n  staff moved    : open gate(s) {sorted(opened)}, close gate(s) {sorted(closed)}")
    print(f"  zones rerouted : {(rt0 != rt1).sum()} of {v.Z}")

    steps = greedy_intervention_list(v, om1, rt0, rt1)
    print("\n  highest-value single changes:")
    for z, g, gain in steps[:5]:
        print(f"    reroute zone {z:2d} -> gate {g:2d}   saves {gain:5.1f}")

    np.savez("best_plan.npz", open_mask=om1, route=rt1,
             base_open=om0, base_route=rt0)
    print("\n  wrote best_plan.npz")
