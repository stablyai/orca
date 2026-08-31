import type { ForegroundProcessEvidence } from './foreground-process-evidence'

export const PTY_IDENTITY_EVIDENCE_CAPABILITY = 'pty.identityEvidence' as const
export const PTY_IDENTITY_EVIDENCE_VERSION = 1 as const

export type PtyIdentityEvidenceRow = {
  id: string
  incarnationId: string
  foregroundProcessEvidence: ForegroundProcessEvidence
}

export type PtyIdentityEvidenceNotification = {
  authorityGeneration: string
  observationEpoch: number
  rows: PtyIdentityEvidenceRow[]
  /** Client-side SSH provider generation; absent on the relay wire. */
  providerGeneration?: number
}

export type PtyIdentityBoundary = 'A' | 'C' | 'D'

/** Chunk-safe scanner for live shell markers. Replay callers intentionally never feed this. */
export function createPtyIdentityBoundaryScanner(
  onBoundary: (boundary: PtyIdentityBoundary) => void
): { feed: (data: string) => void; reset: () => void } {
  let carry = ''
  const maxCarry = 256
  const feed = (data: string): void => {
    if (!data) {
      return
    }
    const input = carry + data
    let cursor = 0
    while (cursor < input.length) {
      const osc = input.indexOf('\x1b]', cursor)
      if (osc === -1) {
        break
      }
      const endBel = input.indexOf('\x07', osc + 2)
      const endSt = input.indexOf('\x1b\\', osc + 2)
      const end = endBel === -1 ? endSt : endSt === -1 ? endBel : Math.min(endBel, endSt)
      if (end < 0) {
        carry = input.slice(osc).slice(-maxCarry)
        return
      }
      const payload = input.slice(osc + 2, end)
      const marker = payload.match(/^133;([ACD])(?:;|$)/)
      if (marker) {
        onBoundary(marker[1] as PtyIdentityBoundary)
      } else if (/^777(?:;|$)/.test(payload)) {
        onBoundary('C')
      }
      cursor = end + (input[end] === '\x07' ? 1 : 2)
    }
    carry = input.slice(Math.max(cursor, input.length - maxCarry))
  }
  return {
    feed,
    reset: () => {
      carry = ''
    }
  }
}
