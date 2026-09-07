#!/usr/bin/env node
/**
 * Busy-spins one CPU core to emulate a loaded machine during latency benches
 * (the "every workspace is running an agent and the whole box is hot" case).
 * Spawn N of these to occupy N cores; kill to release.
 *
 * Usage: node cpu-pressure-worker.mjs [maxDurationMs]
 * The duration failsafe (default 10 min) prevents orphaned spinners if the
 * spawning bench dies without cleanup.
 */
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
