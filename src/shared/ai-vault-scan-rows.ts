import type { AiVaultSession } from './ai-vault/contracts/ai-vault-types'

/** Current membership only; never a completed list or a freshness validator. */
export type AiVaultScanRows = {
  scanId: string
  revision: number
} & (
  | { kind: 'snapshot'; sessions: readonly AiVaultSession[] }
  | { kind: 'delta'; delta: AiVaultRowDelta }
)

export type AiVaultRowDelta = {
  upserts: AiVaultSession[]
  removed: string[]
}

export type AiVaultRowsEvent = AiVaultRowDelta & {
  requestToken: string
  scanId: string
  sequence: number
  reset: boolean
}

export type AiVaultRowObserver = (delta: AiVaultRowDelta) => void | Promise<void>
