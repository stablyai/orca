import type { ForegroundProcessEvidence } from '../../../shared/foreground-process-evidence'

export type PtyIdentityEvidenceStoreRow = {
  hostId: string
  ptyId: string
  incarnationId: string
  authorityGeneration: string
  observationEpoch: number
  evidence: ForegroundProcessEvidence
  receivedAtMs: number
  presentationAgent?: string | null
}

export type PtyIdentityEvidenceStore = ReturnType<typeof createPtyIdentityEvidenceStore>

/** Renderer-wide evidence projection; keyed by execution host to fence reconnects. */
export const ptyIdentityEvidenceStore = createPtyIdentityEvidenceStore()

export function createPtyIdentityEvidenceStore(
  options: {
    now?: () => number
    freshnessMs?: number
  } = {}
) {
  const now = options.now ?? (() => performance.now())
  const freshnessMs = options.freshnessMs ?? 5_000
  const rows = new Map<string, PtyIdentityEvidenceStoreRow>()
  const generationByHost = new Map<string, string>()
  const epochByHost = new Map<string, number>()
  const key = (hostId: string, ptyId: string, incarnationId: string): string =>
    `${hostId}\0${ptyId}\0${incarnationId}`

  const apply = (
    row: Omit<PtyIdentityEvidenceStoreRow, 'receivedAtMs'>,
    restore = false
  ): boolean => {
    const currentGeneration = generationByHost.get(row.hostId)
    const currentEpoch = epochByHost.get(row.hostId) ?? -1
    if (currentGeneration !== undefined && currentGeneration !== row.authorityGeneration) {
      return false
    }
    if (!restore && row.observationEpoch <= currentEpoch) {
      return false
    }
    generationByHost.set(row.hostId, row.authorityGeneration)
    epochByHost.set(row.hostId, Math.max(currentEpoch, row.observationEpoch))
    rows.set(key(row.hostId, row.ptyId, row.incarnationId), {
      ...row,
      receivedAtMs: now() - row.evidence.capturedAgeMs
    })
    return true
  }

  return {
    activateGeneration: (hostId: string, authorityGeneration: string): void => {
      for (const [rowKey, row] of rows) {
        if (row.hostId === hostId) {
          rows.delete(rowKey)
        }
      }
      generationByHost.set(hostId, authorityGeneration)
      epochByHost.set(hostId, -1)
    },
    applyPush: (row: Omit<PtyIdentityEvidenceStoreRow, 'receivedAtMs'>): boolean => apply(row),
    applySeed: (row: Omit<PtyIdentityEvidenceStoreRow, 'receivedAtMs'>): boolean =>
      apply(row, true),
    get: (
      hostId: string,
      ptyId: string,
      incarnationId: string
    ): PtyIdentityEvidenceStoreRow | null => {
      const row = rows.get(key(hostId, ptyId, incarnationId))
      if (!row) {
        return null
      }
      if (now() - row.receivedAtMs > freshnessMs) {
        return {
          ...row,
          evidence: {
            authorityGeneration: row.evidence.authorityGeneration,
            observationEpoch: row.evidence.observationEpoch,
            capturedAgeMs: row.evidence.capturedAgeMs,
            verdict: 'unverifiable',
            reason: 'stale'
          }
        }
      }
      return row
    },
    markHostUnverifiable: (hostId: string): void => {
      for (const [rowKey, row] of rows) {
        if (row.hostId !== hostId) {
          continue
        }
        rows.set(rowKey, {
          ...row,
          evidence: { ...row.evidence, verdict: 'unverifiable', reason: 'disconnected' }
        })
      }
    },
    evict: (hostId: string, ptyId: string, incarnationId?: string): void => {
      for (const [rowKey, row] of rows) {
        if (
          row.hostId === hostId &&
          row.ptyId === ptyId &&
          (!incarnationId || row.incarnationId === incarnationId)
        ) {
          rows.delete(rowKey)
        }
      }
    },
    size: (): number => rows.size,
    snapshot: (): PtyIdentityEvidenceStoreRow[] => Array.from(rows.values())
  }
}
