import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from './child-process/run-process'

/**
 * Whether Squirrel's installer is running for a bundle.
 *
 * Three states, not two. Failing to look is not the same as looking and seeing nothing: if `ps`
 * is denied, times out, or overflows, we know nothing about the installer. Collapsing that into
 * `exited` would let a caller delete installer state out from under a swap that is still
 * running — see docs/reference/ssh-execution-boundary.md, which fixes this exact vocabulary.
 */
export type ShipItLiveness = 'live' | 'unverifiable' | 'exited'

/** `ps` reports whole-second start times; tolerate only that lost precision. */
const PROCESS_START_TIME_TOLERANCE_MS = 1_500
const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 500

export function getShipItLivenessForBundle(bundlePath: string): ShipItLiveness {
  if (process.platform !== 'darwin') {
    return 'exited'
  }
  // Why canonicalise: a symlinked or relocated bundle path spells the same app differently, and
  // `ps` reports whatever path the installer was launched with.
  let resolvedBundlePath = bundlePath
  try {
    resolvedBundlePath = realpathSync(bundlePath)
  } catch {
    // Keep the caller's path when it cannot be resolved.
  }
  // Why the full path and not a bare name: a `ps` match on any command line *mentioning* the
  // bundle would count unrelated processes (a grep, an editor, this very check's own shell) and
  // hold the gate closed forever.
  // Squirrel.Mac has shipped both the framework's versioned resource path and its
  // framework-root symlink as argv[0] across releases. Keep both explicit so we
  // recognize the real installer without broadening the process-table match.
  const shipItPaths = [
    join(
      resolvedBundlePath,
      'Contents',
      'Frameworks',
      'Squirrel.framework',
      'Versions',
      'A',
      'Resources',
      'ShipIt'
    ),
    join(resolvedBundlePath, 'Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt')
  ]
  try {
    const result = runProcessSync({
      program: '/bin/ps',
      args: ['-Ao', 'args='],
      timeoutMs: 2_000
    })
    if (result.code !== 0 || result.outputTruncated) {
      return 'unverifiable'
    }
    // Why argv[0] plus a boundary: anchoring to the start of the line matches a process actually
    // executing ShipIt rather than one that merely names it, and requiring the next character to
    // be a separator stops `.../ShipIt-other` from counting as `.../ShipIt`.
    const running = result.stdout.split('\n').some((line) => {
      const argv0Line = line.trimStart()
      return shipItPaths.some((shipItPath) => {
        if (!argv0Line.startsWith(shipItPath)) {
          return false
        }
        const next = argv0Line.charAt(shipItPath.length)
        return next === '' || next === ' '
      })
    })
    return running ? 'live' : 'exited'
  } catch {
    return 'unverifiable'
  }
}

/** Read process birth times in one bounded probe so marker count cannot multiply subprocesses. */
export function getProcessStartTimes(pids: readonly number[]): ReadonlyMap<number, number> | null {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]
  if (process.platform !== 'darwin' || uniquePids.length === 0) {
    return new Map()
  }
  try {
    const result = runProcessSync({
      program: '/bin/ps',
      args: ['-p', uniquePids.join(','), '-o', 'pid=,lstart='],
      env: { ...process.env, LC_ALL: 'C' },
      timeoutMs: PROCESS_IDENTITY_PROBE_TIMEOUT_MS
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      return null
    }
    const starts = new Map<number, number>()
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(
        line
      )
      if (!match) {
        continue
      }
      const pid = Number(match[1])
      const startedAtMs = Date.parse(match[2])
      if (Number.isInteger(pid) && Number.isFinite(startedAtMs)) {
        starts.set(pid, startedAtMs)
      }
    }
    return starts
  } catch {
    return null
  }
}

/** A PID alone is not ownership evidence because macOS recycles it under process churn. */
export function isRecordedProcessAlive(
  pid: number,
  expectedStartedAtMs: number | undefined,
  starts: ReadonlyMap<number, number> | null
): boolean {
  const actualStartedAtMs = starts?.get(pid)
  return (
    expectedStartedAtMs !== undefined &&
    actualStartedAtMs !== undefined &&
    Math.abs(actualStartedAtMs - expectedStartedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS
  )
}
