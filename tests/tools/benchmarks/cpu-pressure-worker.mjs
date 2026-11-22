#!/usr/bin/env node
// Occupy one CPU core per worker for loaded-machine latency benches; kill to release.
// Usage: node cpu-pressure-worker.mjs [maxDurationMs]; default 10min failsafe prevents orphaned spins after benchmark failure.
const maxDurationMs = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10 * 60 * 1000
const deadline = Date.now() + maxDurationMs

let x = 1
while (Date.now() < deadline) {
  // Hot integer loop between deadline checks; no yields, no allocation.
  for (let i = 0; i < 5_000_000; i++) {
    x = (x * 31 + 7) % 1000003
  }
}
process.exit(0)
