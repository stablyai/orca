import { decodePosixWaitStatus, describePosixWaitStatus } from './posix-wait-status'

/**
 * Renders the exit code with its POSIX wait-status meaning ("61696 (exit status
 * 241)", "9 (SIGKILL)"). The raw value always stays first. Windows codes and
 * launch-failed codes are not wait statuses and render unchanged.
 */
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
