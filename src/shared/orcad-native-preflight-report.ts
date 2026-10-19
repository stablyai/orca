/**
 * `orcad.js --orcad-native-preflight`: the node-pty precondition orcad checks at boot, run on
 * its own so `orca serve` can choose Electron before handing the terminal to an orcad that
 * would refuse to start. One JSON line on stdout, exit 0 whatever the verdict.
 */
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

/** The last report line in `output`, or null when none parses. */
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
    } catch {
      // Not the report line.
    }
  }
  return null
}
