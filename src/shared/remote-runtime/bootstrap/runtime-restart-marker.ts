import { join } from 'node:path'

export const RUNTIME_RESTART_MARKER_FILE = 'orca-runtime-restarting.json'

// A relaunch or install serves again well inside this; past it, a crashed restart must not look busy.
export const RUNTIME_RESTART_MARKER_TTL_MS = 90_000

// A normal restart is back by now: the 20 s forced-quit watchdog plus a launch. Past it, Orca may be down.
export const RUNTIME_RESTART_OVERDUE_MS = 45_000

export type RuntimeRestartReason = 'update' | 'relaunch'

export type RuntimeRestartMarker = {
  reason: RuntimeRestartReason
  /** Epoch ms when the quitting app wrote the marker. */
  writtenAt: number
  /** The quitting app's main pid. */
  pid: number
}

export function getRuntimeRestartMarkerPath(userDataPath: string): string {
  return join(userDataPath, RUNTIME_RESTART_MARKER_FILE)
}

/** The marker if `raw` is well formed and younger than the TTL at `now`; otherwise null. */
export function parseFreshRuntimeRestartMarker(
  raw: string,
  now: number
): RuntimeRestartMarker | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !('reason' in value) ||
    !('writtenAt' in value) ||
    !('pid' in value)
  ) {
    return null
  }
  const { reason, writtenAt, pid } = value
  if (
    (reason !== 'update' && reason !== 'relaunch') ||
    typeof writtenAt !== 'number' ||
    !Number.isFinite(writtenAt) ||
    typeof pid !== 'number' ||
    !Number.isInteger(pid)
  ) {
    return null
  }
  const age = now - writtenAt
  // A marker from the future is a clock jump, not a restart we can time.
  if (age < 0 || age >= RUNTIME_RESTART_MARKER_TTL_MS) {
    return null
  }
  return { reason, writtenAt, pid }
}

/** True once a restart has taken longer than a normal one, so the app may never come back. */
export function isRuntimeRestartOverdue(marker: RuntimeRestartMarker, now: number): boolean {
  return now - marker.writtenAt >= RUNTIME_RESTART_OVERDUE_MS
}
