/** Console formatting and on-disk persistence shared by the startup benchmarks. */
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

export function formatMs(value) {
  if (value === null || value === undefined) {
    return 'n/a'
  }
  return Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
}

/** Signed form for deltas, where direction carries the meaning. */
export function formatSignedMs(value) {
  if (value === null || value === undefined) {
    return 'n/a'
  }
  return value > 0 ? `+${formatMs(value)}` : formatMs(value)
}

// Results are committed as PR evidence — keep home-anchored paths out of them.
export function sanitizeLocalPath(value) {
  if (typeof value !== 'string') {
    return value
  }
  const home = os.homedir()
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

export function writeBenchmarkResults(resultsDir, label, payload) {
  mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `startup-${label}-${stamp}.json`)
  writeFileSync(outPath, JSON.stringify(payload, null, 2))
  return outPath
}

export function machineDescription() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus()[0]?.model
  }
}
