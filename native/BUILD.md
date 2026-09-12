# Building the WASM crowd simulator

`crowd_sim.c` is the agent-based (Helbing social-force) crowd simulator,
compiled to WebAssembly so it runs at native speed inside Electron
without a node-gyp/native-addon build step. The compiled output
(`src/renderer/sim/wasm/crowd_sim.js` + `.wasm`) is checked into the repo
— **end users and normal development never need to rebuild this.**
`npm install && npm start` works with the checked-in build exactly like
any other asset.

You only need to rebuild it if you change `crowd_sim.c` itself.

## One-time setup

Requires [Emscripten](https://emscripten.org). If you don't have it:

```bash
git clone https://github.com/emscripten-core/emsdk.git .tools/emsdk
.tools/emsdk/emsdk install latest
.tools/emsdk/emsdk activate latest
source .tools/emsdk/emsdk_env.sh
```

`.tools/` is gitignored — it's a local build tool, not part of the app.
`source .tools/emsdk/emsdk_env.sh` only affects your current shell; run
it again (or add it to your shell profile) in any new terminal you build
from.

## Building

```bash
./native/build.sh
```

Rebuilds `src/renderer/sim/wasm/crowd_sim.{js,wasm}` from `crowd_sim.c`.
Commit both output files along with your `.c` change.

## Why WASM instead of a native Node addon

A native addon (N-API / node-gyp) would need to be compiled per-platform
against the exact Electron/Node ABI in use, which breaks the project's
`npm install && npm start` setup for anyone on a different OS or Electron
version. A WebAssembly module is a single, portable build artifact the
renderer loads like any other asset — no native toolchain needed by
anyone except whoever last touched `crowd_sim.c`.
