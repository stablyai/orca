import { decodePosixWaitStatus, describePosixWaitStatus } from './posix-wait-status'
import { decodeWindowsCrashExitCode, describeWindowsCrashExitCode } from './windows-crash-exit-code'
import {
  decodeWindowsLaunchFailureCode,
  describeWindowsLaunchFailureCode
} from './windows-launch-failure-code'

type CrashReportExitCode = {
  exitCode: number | null
  platform: NodeJS.Platform
  reason: string
}

/**
 * The platform meaning of an exit code, or null when it has none worth showing:
 * "exit status 241", "SIGKILL", "0xFFFF7001, crash handler unreachable; client
 * self-terminated without a minidump". Every caller that renders a decoded exit
 * code goes through here, so the report text and the span attribute cannot drift.
 * `reason`, not the number, picks the namespace: launch-failed names a launch stage.
 */
export function describeCrashReportExitCode(report: CrashReportExitCode): string | null {
  if (report.exitCode === null || report.exitCode === undefined) {
    return null
  }
  if (report.reason === 'launch-failed') {
    // Decoded before the platform branch so a launch code can never borrow a table that
    // would misname it. win32 only: off-Windows Chromium reports nothing but a generic code.
    if (report.platform !== 'win32') {
      return null
    }
    const launchDecoded = decodeWindowsLaunchFailureCode(report.exitCode)
    return launchDecoded ? describeWindowsLaunchFailureCode(launchDecoded) : null
  }
  if (report.platform === 'win32') {
    const windowsDecoded = decodeWindowsCrashExitCode(report.exitCode)
    return windowsDecoded ? describeWindowsCrashExitCode(windowsDecoded) : null
  }
  const decoded = decodePosixWaitStatus(report.exitCode)
  // A clean exit(0) decodes to itself; the suffix would only add noise.
  if (!decoded || (decoded.kind === 'exited' && report.exitCode === 0)) {
    return null
  }
  return describePosixWaitStatus(decoded)
}

/** Renders the raw exit code first, then its meaning in parentheses if it has one. */
export function formatCrashReportExitCode(report: CrashReportExitCode): string {
  if (report.exitCode === null || report.exitCode === undefined) {
    return 'unknown'
  }
  const described = describeCrashReportExitCode(report)
  return described === null ? String(report.exitCode) : `${report.exitCode} (${described})`
}
