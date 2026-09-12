#!/usr/bin/env bash
# Rebuilds the WASM crowd simulator from native/crowd_sim.c.
#
# Requires the Emscripten SDK (emcc) on PATH. If you don't have it:
#   git clone https://github.com/emscripten-core/emsdk.git .tools/emsdk
#   .tools/emsdk/emsdk install latest && .tools/emsdk/emsdk activate latest
#   source .tools/emsdk/emsdk_env.sh
# (.tools/ is gitignored — it's a local build tool, not part of the app.)
#
# End users never need this: the compiled output is checked into
# src/renderer/sim/wasm/ and loaded directly, same as any other asset.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v emcc >/dev/null || {
  echo "emcc not found on PATH — see the comment at the top of this script." >&2
  exit 1
}

mkdir -p src/renderer/sim/wasm

emcc native/crowd_sim.c \
  -O3 \
  -o src/renderer/sim/wasm/crowd_sim.js \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createCrowdSimModule \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="['_wasm_init','_wasm_step','_wasm_rasterize','_wasm_get_agent_count','_wasm_get_admitted','_wasm_get_exited','_wasm_get_phase','_wasm_get_phase_switch_time','_wasm_malloc','_wasm_free']" \
  -s EXPORTED_RUNTIME_METHODS="['HEAPU8','HEAPF32']"

echo "Built src/renderer/sim/wasm/crowd_sim.js (+ .wasm)."
