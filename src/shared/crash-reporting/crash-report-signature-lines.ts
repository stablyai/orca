import type { CrashReportDetailValue } from './crash-reporting'

/** Surface Crashpad fatal lines above details: Chromium CHECK’s bare STATUS_BREAKPOINT cannot identify the cause. */
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
