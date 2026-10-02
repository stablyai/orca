/**
 * The contract between the Windows relay launch script (main) and the one-shot launcher mode of
 * `relay.js` that starts the detached relay outside the SSH session's job object.
 */

export const RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG = '--windows-breakaway-launch'
export const RELAY_WINDOWS_BREAKAWAY_STDOUT_FLAG = '--stdout-file'
export const RELAY_WINDOWS_BREAKAWAY_STDERR_FLAG = '--stderr-file'
/** Everything after it is the relay's own argv. Not `--`: Windows PowerShell may consume that. */
export const RELAY_WINDOWS_BREAKAWAY_ARGS_FLAG = '--relay-args'

/** The launcher's one report line, followed by a JSON object. */
export const RELAY_WINDOWS_LAUNCH_REPORT_MARKER = 'ORCA_RELAY_LAUNCH'

/**
 * `unavailable` means this host cannot use the launcher (no addon, an addon that predates it, or
 * a job that refuses breakaway); the launch script then tries WMI.
 */
export const RELAY_WINDOWS_BREAKAWAY_EXIT_CODES = {
  launched: 0,
  failed: 1,
  unavailable: 3
} as const

export type RelayWindowsLaunchReport =
  | { method: 'breakaway'; pid: number; inJob: boolean }
  | { method: 'wmi' }
  | { method: 'unavailable'; reason: string; step?: string; code?: number }
  | { method: 'failed'; reason: string; step?: string; code?: number }

/** The last report line in `output`, or null when none parses. */
export function parseRelayWindowsLaunchReport(output: string): RelayWindowsLaunchReport | null {
  const lines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(RELAY_WINDOWS_LAUNCH_REPORT_MARKER))
  const last = lines.at(-1)
  if (!last) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(last.slice(RELAY_WINDOWS_LAUNCH_REPORT_MARKER.length).trim())
    if (!parsed || typeof parsed !== 'object' || !('method' in parsed)) {
      return null
    }
    const record = Object.fromEntries(Object.entries(parsed))
    switch (record.method) {
      case 'breakaway':
        return typeof record.pid === 'number'
          ? { method: 'breakaway', pid: record.pid, inJob: record.inJob === true }
          : null
      case 'wmi':
        return { method: 'wmi' }
      case 'unavailable':
      case 'failed':
        return {
          method: record.method,
          reason: typeof record.reason === 'string' ? record.reason : 'unknown',
          ...(typeof record.step === 'string' ? { step: record.step } : {}),
          ...(typeof record.code === 'number' ? { code: record.code } : {})
        }
      default:
        return null
    }
  } catch {
    return null
  }
}

export function formatRelayWindowsLaunchReport(report: RelayWindowsLaunchReport): string {
  return `${RELAY_WINDOWS_LAUNCH_REPORT_MARKER} ${JSON.stringify(report)}`
}
