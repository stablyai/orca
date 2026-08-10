import {
  assertGitStagedDiscardReceipt,
  failedGitStagedDiscardReceipt,
  gitStagedDiscardOperationTimestamp,
  type GitStagedDiscardReceipt
} from './git-staged-discard-receipt'

type ReceiptEntry = {
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
  entries: Omit<ReceiptEntry, 'promise'>[]
}

export type GitStagedDiscardReceiptLedgerStorage = {
  load(): unknown
  save(snapshot: GitStagedDiscardReceiptLedgerSnapshot): void
}

export type GitStagedDiscardReceiptLedgerOptions = {
  maxReceipts?: number
  retentionMs?: number
  storage?: GitStagedDiscardReceiptLedgerStorage
  now?: () => number
}

const DEFAULT_MAX_RECEIPTS = 256
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000

export class GitStagedDiscardReceiptLedger {
  private readonly entries = new Map<string, ReceiptEntry>()
  private readonly maxReceipts: number
  private readonly retentionMs: number
  private readonly storage?: GitStagedDiscardReceiptLedgerStorage
  private readonly now: () => number
  private rejectUnknownLegacyOperationIds = false
  private retiredOperationTimestamp = -1
  private loadError: Error | null = null

  constructor(options: number | GitStagedDiscardReceiptLedgerOptions = {}) {
    const resolved = typeof options === 'number' ? { maxReceipts: options } : options
    this.maxReceipts = resolved.maxReceipts ?? DEFAULT_MAX_RECEIPTS
    this.retentionMs = resolved.retentionMs ?? DEFAULT_RETENTION_MS
    this.storage = resolved.storage
    this.now = resolved.now ?? Date.now
    this.hydrate()
  }

  run(
    scope: string,
    operationId: string,
    fingerprint: string,
    pending: GitStagedDiscardReceipt,
    operation: () => Promise<GitStagedDiscardReceipt>
  ): Promise<GitStagedDiscardReceipt> {
    try {
      this.assertAvailable()
      const existing = this.entries.get(receiptKey(scope, operationId))
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error('Staged discard operation ID was reused')
        }
        return existing.promise
      }
      this.prepareNewOperation(operationId)
      assertGitStagedDiscardReceipt(pending, operationId, pending.affectedPaths)
      const entry = this.startEntry(scope, operationId, fingerprint, pending)
      try {
        this.persist()
      } catch (error) {
        this.entries.delete(receiptKey(scope, operationId))
        throw error
      }
      entry.promise = Promise.resolve()
        .then(operation)
        .then(
          (receipt) => this.settle(entry, receipt),
          (error) =>
            this.settle(
              entry,
              failedGitStagedDiscardReceipt(operationId, pending.affectedPaths, error)
            )
        )
      return entry.promise
    } catch (error) {
      return Promise.reject(error)
    }
  }

  get(scope: string, operationId: string): GitStagedDiscardReceipt | null {
    this.assertAvailable()
    return this.entries.get(receiptKey(scope, operationId))?.receipt ?? null
  }

  update(
    scope: string,
    operationId: string,
    value: GitStagedDiscardReceipt
  ): GitStagedDiscardReceipt | null {
    this.assertAvailable()
    const entry = this.entries.get(receiptKey(scope, operationId))
    if (!entry) {
      return null
    }
    return this.settle(entry, value)
  }

  private startEntry(
    scope: string,
    operationId: string,
    fingerprint: string,
    pending: GitStagedDiscardReceipt
  ): ReceiptEntry {
    const entry: ReceiptEntry = {
      scope,
      operationId,
      fingerprint,
      createdAt: this.now(),
      receipt: pending,
      promise: Promise.resolve(pending)
    }
    this.entries.set(receiptKey(scope, operationId), entry)
    return entry
  }

  private settle(entry: ReceiptEntry, value: GitStagedDiscardReceipt): GitStagedDiscardReceipt {
    const receipt = assertGitStagedDiscardReceipt(
      value,
      entry.operationId,
      entry.receipt.affectedPaths
    )
    if (entry.receipt.state !== 'pending') {
      if (receipt.state === 'pending' || sameReceipt(entry.receipt, receipt)) {
        return entry.receipt
      }
      throw new Error('The Git owner returned contradictory staged discard settlements')
    }
    entry.receipt = receipt
    entry.promise = Promise.resolve(receipt)
    this.persist()
    return receipt
  }

  private prepareNewOperation(operationId: string): void {
    const now = this.now()
    this.evictExpired(now)
    const timestamp = gitStagedDiscardOperationTimestamp(operationId)
    if (timestamp === null && this.rejectUnknownLegacyOperationIds) {
      throw new Error('This staged discard operation predates the retained replay window')
    }
    if (timestamp !== null && timestamp <= this.retiredOperationTimestamp) {
      throw new Error('Staged discard operation is outside the replay window')
    }
    if (this.entries.size >= this.maxReceipts) {
      throw new Error('Too many staged discard operations are retained for safe replay')
    }
  }

  private evictExpired(now: number): void {
    let changed = false
    for (const [key, entry] of this.entries) {
      if (entry.receipt.state === 'pending' || entry.createdAt > now - this.retentionMs) {
        continue
      }
      const timestamp = gitStagedDiscardOperationTimestamp(entry.operationId)
      if (timestamp === null) {
        this.rejectUnknownLegacyOperationIds = true
      } else {
        this.retiredOperationTimestamp = Math.max(this.retiredOperationTimestamp, timestamp)
      }
      this.entries.delete(key)
      changed = true
    }
    if (changed) {
      this.persist()
    }
  }

  private hydrate(): void {
    if (!this.storage) {
      return
    }
    try {
      const value = this.storage.load()
      if (value === null || value === undefined) {
        return
      }
      const snapshot = parseSnapshot(value)
      if (snapshot.entries.length > this.maxReceipts) {
        throw new Error('Staged discard ledger exceeds its retention bound')
      }
      this.rejectUnknownLegacyOperationIds = snapshot.rejectUnknownLegacyOperationIds
      this.retiredOperationTimestamp = snapshot.retiredOperationTimestamp
      let recoveredPending = false
      for (const durable of snapshot.entries) {
        const receipt =
          durable.receipt.state === 'pending'
            ? interruptedReceipt(durable.operationId, durable.receipt.affectedPaths)
            : durable.receipt
        recoveredPending ||= receipt !== durable.receipt
        const entry = { ...durable, receipt, promise: Promise.resolve(receipt) }
        this.entries.set(receiptKey(entry.scope, entry.operationId), entry)
      }
      this.evictExpired(this.now())
      if (recoveredPending) {
        this.persist()
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error('Invalid staged discard ledger')
    }
  }

  private persist(): void {
    this.storage?.save({
      version: 1,
      rejectUnknownLegacyOperationIds: this.rejectUnknownLegacyOperationIds,
      retiredOperationTimestamp: this.retiredOperationTimestamp,
      entries: [...this.entries.values()].map(({ promise: _promise, ...entry }) => entry)
    })
  }

  private assertAvailable(): void {
    if (this.loadError) {
      throw new Error('The staged discard replay ledger is unavailable', { cause: this.loadError })
    }
  }
}

function sameReceipt(left: GitStagedDiscardReceipt, right: GitStagedDiscardReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function receiptKey(scope: string, operationId: string): string {
  return `${scope}\0${operationId}`
}

function interruptedReceipt(
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
    error: 'Staged discard was interrupted before authoritative settlement'
  }
}

function parseSnapshot(value: unknown): GitStagedDiscardReceiptLedgerSnapshot {
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
    entries
  }
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
