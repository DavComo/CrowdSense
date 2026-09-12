# Optimizer setup

One-time step so the editor's **Optimize Layout…** button (and this
directory's scripts generally) can run. Requires Python 3 with `numpy`
— nothing else for the core pipeline (`run_pipeline.py`, `arena.py`,
`sim.py`, `surrogate.py`). A separate, heavier U-Net tier
(`unet.py`/`run_unet_pipeline.py`) additionally needs `torch`, but the
editor's button doesn't use that tier.

```bash
cd optimizer
python3 -m venv .venv
.venv/bin/pip install numpy
```

That's it — `.venv/` is gitignored (regenerate it any time with the
commands above; nothing inside it is meant to be committed).

The editor looks for this exact virtualenv
(`optimizer/.venv/bin/python3`, or `optimizer\.venv\Scripts\python.exe`
on Windows) — never your system Python — so this one setup step is all
"Optimize Layout…" needs. If you skip it, clicking the button shows an
error with these same two commands.

## Verifying it works

```bash
cd optimizer
source .venv/bin/activate
CROWDSENSE_N=10 python3 run_pipeline.py
```

Should print progress and finish with `wrote
.../optimizer/optimized-venue.json` in well under a minute.
`CROWDSENSE_N` (default 420 on the CLI; the app itself asks for 100 —
see `src/main/main.js`'s `optimizer:run` handler) is how many
simulator-scored samples the surrogate trains on; more is slower but
searches more thoroughly.
