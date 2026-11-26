import { decodePosixWaitStatus, describePosixWaitStatus } from './posix-wait-status'

/** Show raw POSIX wait status before decoded exit/signal meaning; preserve Windows and launch-failed codes unchanged. */
export function formatCrashReportExitCode(report: {
  exitCode: number | null
  platform: NodeJS.Platform
  reason: string
}): string {
  if (report.exitCode === null || report.exitCode === undefined) {
    return 'unknown'
  }
  const decoded =
    report.platform === 'win32' || report.reason === 'launch-failed'
      ? null
      : decodePosixWaitStatus(report.exitCode)
  // A clean exit(0) decodes to itself; the suffix would only add noise.
  if (!decoded || (decoded.kind === 'exited' && report.exitCode === 0)) {
    return String(report.exitCode)
  }
  return `${report.exitCode} (${describePosixWaitStatus(decoded)})`
}
