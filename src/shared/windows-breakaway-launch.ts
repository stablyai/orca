/**
 * The contract between a Windows launch script (main) and the one-shot launcher mode that
 * `relay.js` and `orcad.js` both expose to start a detached process outside the SSH session's
 * job object. The flags are shared; each program names its own args separator and report marker.
 */

export const WINDOWS_BREAKAWAY_LAUNCH_FLAG = '--windows-breakaway-launch'
export const WINDOWS_BREAKAWAY_STDOUT_FLAG = '--stdout-file'
export const WINDOWS_BREAKAWAY_STDERR_FLAG = '--stderr-file'
/** Optional: where to record the launched PID and its creation time as JSON. */
export const WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG = '--process-file'
/** Optional, valueless: keep the previous run's stderr as `<file>.1`; the addon truncates the file. */
export const WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG = '--stderr-keep-previous'
/** Repeatable `NAME=VALUE` the launched process inherits; argv is the only channel both SSH shells share. */
export const WINDOWS_BREAKAWAY_ENV_FLAG = '--env'

export type WindowsBreakawayLaunchContract = {
  /** Everything after it is the program's own argv. Not `--`: Windows PowerShell may consume that. */
  argsFlag: string
  /** The launcher's one report line starts with this, followed by a JSON object. */
  reportMarker: string
}

export const RELAY_WINDOWS_BREAKAWAY_CONTRACT: WindowsBreakawayLaunchContract = {
  argsFlag: '--relay-args',
  reportMarker: 'ORCA_RELAY_LAUNCH'
}

export const ORCAD_WINDOWS_BREAKAWAY_CONTRACT: WindowsBreakawayLaunchContract = {
  argsFlag: '--orcad-args',
  reportMarker: 'ORCA_ORCAD_LAUNCH'
}

/**
 * `unavailable` means this host cannot use the launcher (no addon, an addon that predates it, or
 * a job that refuses breakaway); the relay's script then tries WMI, orcad's refuses.
 */
export const WINDOWS_BREAKAWAY_EXIT_CODES = {
  launched: 0,
  failed: 1,
  unavailable: 3
} as const

export type WindowsBreakawayLaunchReport =
  | { method: 'breakaway'; pid: number; inJob: boolean; creationTimeMs?: number }
  | { method: 'wmi' }
  | { method: 'unavailable'; reason: string; step?: string; code?: number }
  | { method: 'failed'; reason: string; step?: string; code?: number }

/** The last report line in `output`, or null when none parses. */
export function parseWindowsBreakawayLaunchReport(
  contract: WindowsBreakawayLaunchContract,
  output: string
): WindowsBreakawayLaunchReport | null {
  const last = output.split(/\r?\n/u).findLast((line) => line.startsWith(contract.reportMarker))
  if (!last) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(last.slice(contract.reportMarker.length).trim())
    if (!parsed || typeof parsed !== 'object' || !('method' in parsed)) {
      return null
    }
    const record = Object.fromEntries(Object.entries(parsed))
    switch (record.method) {
      case 'breakaway':
        return typeof record.pid === 'number'
          ? {
              method: 'breakaway',
              pid: record.pid,
              inJob: record.inJob === true,
              ...(typeof record.creationTimeMs === 'number'
                ? { creationTimeMs: record.creationTimeMs }
                : {})
            }
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

export function formatWindowsBreakawayLaunchReport(
  contract: WindowsBreakawayLaunchContract,
  report: WindowsBreakawayLaunchReport
): string {
  return `${contract.reportMarker} ${JSON.stringify(report)}`
}
