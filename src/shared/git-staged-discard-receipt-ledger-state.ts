import {
  assertGitStagedDiscardReceipt,
  type GitStagedDiscardReceipt
} from './git-staged-discard-receipt'

export type GitStagedDiscardReceiptEntry = {
  scope: string
  operationId: string
  fingerprint: string
  createdAt: number
  receipt: GitStagedDiscardReceipt
  promise: Promise<GitStagedDiscardReceipt>
}

export type GitStagedDiscardReceiptLedgerSnapshot = {
  version: 1
  rejectUnknownLegacyOperationIds: boolean
  retiredOperationTimestamp: number
  retiredSkewedOperationIds?: string[]
  entries: Omit<GitStagedDiscardReceiptEntry, 'promise'>[]
}

export type GitStagedDiscardReceiptLedgerChange = {
  upsert?: Omit<GitStagedDiscardReceiptEntry, 'promise'>
  removedKeys?: string[]
  rejectUnknownLegacyOperationIds: boolean
  retiredOperationTimestamp: number
  retiredSkewedOperationIds: string[]
}

export type GitStagedDiscardReceiptLedgerStorage = {
  load(): unknown
  save(snapshot: GitStagedDiscardReceiptLedgerSnapshot): void
  append?(
    change: GitStagedDiscardReceiptLedgerChange,
    snapshot: GitStagedDiscardReceiptLedgerSnapshot
  ): void
}

export type GitStagedDiscardReceiptLedgerOptions = {
  maxReceipts?: number
  retentionMs?: number
  maxBytes?: number
  storage?: GitStagedDiscardReceiptLedgerStorage
  now?: () => number
}

export function persistGitStagedDiscardReceiptLedger(
  storage: GitStagedDiscardReceiptLedgerStorage | undefined,
  change: GitStagedDiscardReceiptLedgerChange,
  snapshot: GitStagedDiscardReceiptLedgerSnapshot
): void {
  if (!storage) {
    return
  }
  if (storage.append) {
    storage.append(change, snapshot)
  } else {
    storage.save(snapshot)
  }
}

export function createGitStagedDiscardReceiptLedgerSnapshot(
  entries: Iterable<GitStagedDiscardReceiptEntry>,
  rejectUnknownLegacyOperationIds: boolean,
  retiredOperationTimestamp: number,
  retiredSkewedOperationIds: Iterable<string>
): GitStagedDiscardReceiptLedgerSnapshot {
  return {
    version: 1,
    rejectUnknownLegacyOperationIds,
    retiredOperationTimestamp,
    retiredSkewedOperationIds: [...retiredSkewedOperationIds],
    entries: [...entries].map(durableGitStagedDiscardReceiptEntry)
  }
}

export const MAX_RETIRED_SKEWED_OPERATION_IDS = 4_096
const INTERRUPTED_ERROR = 'Staged discard was interrupted before authoritative settlement'

export function durableGitStagedDiscardReceiptEntry(
  entry: GitStagedDiscardReceiptEntry
): Omit<GitStagedDiscardReceiptEntry, 'promise'> {
  const { promise: _promise, ...durable } = entry
  return durable
}

export function createGitStagedDiscardReceiptEntry(
  scope: string,
  operationId: string,
  fingerprint: string,
  createdAt: number,
  receipt: GitStagedDiscardReceipt
): GitStagedDiscardReceiptEntry {
  return {
    scope,
    operationId,
    fingerprint,
    createdAt,
    receipt,
    promise: Promise.resolve(receipt)
  }
}

export function gitStagedDiscardReceiptEntriesBytes(
  entries: Iterable<GitStagedDiscardReceiptEntry>
): number {
  let total = 0
  for (const entry of entries) {
    total += gitStagedDiscardReceiptEntryBytes(entry)
  }
  return total
}

export function gitStagedDiscardReceiptEntryBytes(entry: GitStagedDiscardReceiptEntry): number {
  return Buffer.byteLength(JSON.stringify(durableGitStagedDiscardReceiptEntry(entry)), 'utf8')
}

export function sameGitStagedDiscardReceipt(
  left: GitStagedDiscardReceipt,
  right: GitStagedDiscardReceipt
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function assertGitStagedDiscardReceiptLedgerAvailable(loadError: Error | null): void {
  if (loadError) {
    throw new Error('The staged discard replay ledger is unavailable', { cause: loadError })
  }
}

export function isInterruptedGitStagedDiscardReceipt(receipt: GitStagedDiscardReceipt): boolean {
  return (
    receipt.state === 'failed' &&
    receipt.mutation === 'possible' &&
    receipt.error === INTERRUPTED_ERROR
  )
}

export function gitStagedDiscardReceiptKey(scope: string, operationId: string): string {
  return `${scope}\0${operationId}`
}

export function interruptedGitStagedDiscardReceipt(
  operationId: string,
  affectedPaths: readonly string[]
): GitStagedDiscardReceipt {
  return {
    operationId,
    state: 'failed',
    mutation: 'possible',
    affectedPaths: [...affectedPaths],
    completedPaths: [],
    uncertainPaths: [...affectedPaths],
    remainingPaths: [],
    error: INTERRUPTED_ERROR
  }
}

export function parseGitStagedDiscardReceiptLedgerSnapshot(
  value: unknown
): GitStagedDiscardReceiptLedgerSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid staged discard ledger')
  }
  const snapshot = value as Partial<GitStagedDiscardReceiptLedgerSnapshot>
  if (
    snapshot.version !== 1 ||
    typeof snapshot.rejectUnknownLegacyOperationIds !== 'boolean' ||
    !Array.isArray(snapshot.entries)
  ) {
    throw new Error('Invalid staged discard ledger')
  }
  const entries = snapshot.entries.map((entry) => {
    if (
      !entry ||
      typeof entry.scope !== 'string' ||
      typeof entry.operationId !== 'string' ||
      typeof entry.fingerprint !== 'string' ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0
    ) {
      throw new Error('Invalid staged discard ledger entry')
    }
    return {
      ...entry,
      receipt: assertGitStagedDiscardReceipt(
        entry.receipt,
        entry.operationId,
        (entry.receipt as GitStagedDiscardReceipt).affectedPaths
      )
    }
  })
  return {
    version: 1,
    rejectUnknownLegacyOperationIds: snapshot.rejectUnknownLegacyOperationIds,
    retiredOperationTimestamp: parseRetiredOperationTimestamp(snapshot.retiredOperationTimestamp),
    retiredSkewedOperationIds: parseRetiredSkewedOperationIds(snapshot.retiredSkewedOperationIds),
    entries
  }
}

function parseRetiredSkewedOperationIds(value: unknown): string[] {
  if (value === undefined) {
    return []
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_RETIRED_SKEWED_OPERATION_IDS ||
    !value.every((operationId) => typeof operationId === 'string' && operationId.length <= 128)
  ) {
    throw new Error('Invalid staged discard ledger skewed replay identities')
  }
  return [...new Set(value)]
}

function parseRetiredOperationTimestamp(value: unknown): number {
  if (value === undefined) {
    return -1
  }
  if (!Number.isSafeInteger(value) || (value as number) < -1) {
    throw new Error('Invalid staged discard ledger retirement fence')
  }
  return value as number
}
