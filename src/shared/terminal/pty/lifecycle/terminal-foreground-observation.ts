/** Fresh recipient observation, never child-census or destructive-action evidence. */
export type TerminalForegroundObservation = {
  ptyId: string
  ptyIncarnationId: string
  authorityGeneration: string
  observationEpoch: number
  capturedAgeMs: number
} & TerminalForegroundSample

export type TerminalForegroundSample =
  | {
      verdict: 'observed'
      source: 'pty-master' | 'posix-process-table' | 'windows-console'
      foregroundKind: 'shell' | 'non-shell'
      processName: string | null
      tty?: string
      foregroundPgid?: number
    }
  | {
      verdict: 'unverifiable'
      reason: string
      source?: 'pty-master' | 'posix-process-table' | 'windows-console'
    }

export function isTerminalForegroundObservation(
  value: unknown
): value is TerminalForegroundObservation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= 4096
  const integer = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (
    !('ptyId' in value) ||
    !text(value.ptyId) ||
    !('ptyIncarnationId' in value) ||
    !text(value.ptyIncarnationId) ||
    !('authorityGeneration' in value) ||
    !text(value.authorityGeneration) ||
    !('observationEpoch' in value) ||
    !integer(value.observationEpoch) ||
    !('capturedAgeMs' in value) ||
    !integer(value.capturedAgeMs) ||
    !('verdict' in value)
  ) {
    return false
  }
  const source = 'source' in value ? value.source : undefined
  if (
    source !== undefined &&
    (typeof source !== 'string' ||
      !['pty-master', 'posix-process-table', 'windows-console'].includes(source))
  ) {
    return false
  }
  if (value.verdict === 'unverifiable') {
    return 'reason' in value && text(value.reason)
  }
  return (
    value.verdict === 'observed' &&
    source !== undefined &&
    'foregroundKind' in value &&
    (value.foregroundKind === 'shell' || value.foregroundKind === 'non-shell') &&
    'processName' in value &&
    (value.processName === null || text(value.processName)) &&
    (!('tty' in value) || text(value.tty)) &&
    (!('foregroundPgid' in value) || (integer(value.foregroundPgid) && value.foregroundPgid > 0))
  )
}
