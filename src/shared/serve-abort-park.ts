import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How long a macOS startup abort keeps later `orca serve` runs from the same environment out. */
export const SERVE_ABORT_PARK_MS = 30 * 60_000

/** The exit code a parked `orca serve` refuses with (EX_CONFIG): retrying cannot help. */
export const SERVE_ABORT_PARK_EXIT_CODE = 78

export type ServeAbortPark = {
  schemaVersion: 1
  verdict: 'environment_abort'
  at: number
  envFingerprint: string
  diagnostic: string
}

export function serveAbortParkPath(userDataPath: string): string {
  return join(userDataPath, 'serve-supervisor-journal.json')
}

function parseServeAbortPark(raw: string): ServeAbortPark | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (
      typeof value === 'object' &&
      value !== null &&
      'schemaVersion' in value &&
      value.schemaVersion === 1 &&
      'verdict' in value &&
      value.verdict === 'environment_abort' &&
      'at' in value &&
      typeof value.at === 'number' &&
      'envFingerprint' in value &&
      typeof value.envFingerprint === 'string' &&
      'diagnostic' in value &&
      typeof value.diagnostic === 'string'
    ) {
      return {
        schemaVersion: 1,
        verdict: 'environment_abort',
        at: value.at,
        envFingerprint: value.envFingerprint,
        diagnostic: value.diagnostic
      }
    }
  } catch {
    // An unreadable journal parks nothing.
  }
  return null
}

export function readServeAbortPark(userDataPath: string): ServeAbortPark | null {
  try {
    return parseServeAbortPark(readFileSync(serveAbortParkPath(userDataPath), 'utf8'))
  } catch {
    return null
  }
}

/** A park applies only to the environment that aborted, and only for a while. */
export function isServeAbortParkActive(
  park: ServeAbortPark | null,
  envFingerprint: string,
  now: number
): park is ServeAbortPark {
  return (
    park !== null &&
    park.envFingerprint === envFingerprint &&
    now >= park.at &&
    now - park.at < SERVE_ABORT_PARK_MS
  )
}

export function writeServeAbortPark(userDataPath: string, park: ServeAbortPark): void {
  try {
    writeFileSync(serveAbortParkPath(userDataPath), JSON.stringify(park), { mode: 0o600 })
  } catch {
    // Fail open: a park that cannot be recorded only costs the next run one more abort.
  }
}

/** A serve that reached readiness, or an explicit --force, proves the park no longer applies. */
export function clearServeAbortPark(userDataPath: string): void {
  try {
    rmSync(serveAbortParkPath(userDataPath), { force: true })
  } catch {
    // Nothing to clear, or the profile is read-only; either way nothing is parked by us.
  }
}
