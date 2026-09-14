// Type-only, so this erases at compile time and creates no import cycle.
import type { CrashReportDetailValue } from './crash-reporting'

/**
 * Promotes the Crashpad-derived fields out of the details blob.
 *
 * Why: for a Chromium CHECK the exit code is only 0x80000003 (STATUS_BREAKPOINT),
 * so the fatal log line is the actual diagnosis and must not be buried in a
 * detail list the reader scrolls past.
 */
export function appendMinidumpSignatureLines(
  lines: string[],
  details: Record<string, CrashReportDetailValue>
): void {
  if (typeof details.minidumpCheckMessage === 'string') {
    lines.push(`Check failure: ${details.minidumpCheckMessage}`)
  }
  if (typeof details.minidumpFaultingModule === 'string') {
    const offset = details.minidumpFaultingModuleOffset
    const suffix = typeof offset === 'string' ? `+${offset}` : ''
    lines.push(`Faulting module: ${details.minidumpFaultingModule}${suffix}`)
  }
}
