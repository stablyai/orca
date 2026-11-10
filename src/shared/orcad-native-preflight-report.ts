/** orca serve probes node-pty separately to choose Electron before handing off to an orcad that cannot start.
 * Print one JSON line and exit 0 for every verdict. */
export const ORCAD_NATIVE_PREFLIGHT_FLAG = '--orcad-native-preflight'
const REPORT_TYPE = 'orcad_native_preflight'

export type OrcadNativePreflightReport = {
  type: typeof REPORT_TYPE
  status: 'ok' | 'degraded' | 'blocked' | 'unverifiable'
  reason: string | null
}

export function formatOrcadNativePreflightReport(
  status: OrcadNativePreflightReport['status'],
  reason: string | null
): string {
  return JSON.stringify({ type: REPORT_TYPE, status, reason })
}

export function parseOrcadNativePreflightReport(output: string): OrcadNativePreflightReport | null {
  for (const line of output.split(/\r?\n/u).toReversed()) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'type' in parsed &&
        parsed.type === REPORT_TYPE &&
        'status' in parsed &&
        (parsed.status === 'ok' ||
          parsed.status === 'degraded' ||
          parsed.status === 'blocked' ||
          parsed.status === 'unverifiable')
      ) {
        const reason =
          'reason' in parsed && typeof parsed.reason === 'string' ? parsed.reason : null
        return { type: REPORT_TYPE, status: parsed.status, reason }
      }
    } catch {}
  }
  return null
}
