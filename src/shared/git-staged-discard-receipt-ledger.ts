import {
  assertGitStagedDiscardReceipt,
  failedGitStagedDiscardReceipt,
  gitStagedDiscardOperationTimestamp,
  type GitStagedDiscardReceipt
} from './git-staged-discard-receipt'
import { GitStagedDiscardReceiptEntryMap } from './git-staged-discard-receipt-entry-map'
import {
  assertGitStagedDiscardReceiptLedgerAvailable,
  createGitStagedDiscardReceiptEntry,
  createGitStagedDiscardReceiptLedgerSnapshot,
  durableGitStagedDiscardReceiptEntry,
  gitStagedDiscardReceiptKey,
  interruptedGitStagedDiscardReceipt,
  isInterruptedGitStagedDiscardReceipt,
  MAX_RETIRED_SKEWED_OPERATION_IDS,
  parseGitStagedDiscardReceiptLedgerSnapshot,
  persistGitStagedDiscardReceiptLedger,
  sameGitStagedDiscardReceipt,
  type GitStagedDiscardReceiptEntry,
  type GitStagedDiscardReceiptLedgerChange,
  type GitStagedDiscardReceiptLedgerOptions,
  type GitStagedDiscardReceiptLedgerSnapshot,
  type GitStagedDiscardReceiptLedgerStorage
} from './git-staged-discard-receipt-ledger-state'

export type {
  GitStagedDiscardReceiptLedgerChange,
  GitStagedDiscardReceiptLedgerOptions,
  GitStagedDiscardReceiptLedgerSnapshot,
  GitStagedDiscardReceiptLedgerStorage
} from './git-staged-discard-receipt-ledger-state'

const DEFAULT_MAX_RECEIPTS = 256
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const MAX_TRUSTED_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1_000

export class GitStagedDiscardReceiptLedger {
  private readonly entries = new GitStagedDiscardReceiptEntryMap()
  private readonly maxReceipts: number
  private readonly retentionMs: number
  private readonly maxBytes: number
  private readonly storage?: GitStagedDiscardReceiptLedgerStorage
  private readonly now: () => number
  private rejectUnknownLegacyOperationIds = false
  private retiredOperationTimestamp = -1
  private readonly retiredSkewedOperationIds = new Set<string>()
  private loadError: Error | null = null

  constructor(options: number | GitStagedDiscardReceiptLedgerOptions = {}) {
    const resolved = typeof options === 'number' ? { maxReceipts: options } : options
    this.maxReceipts = resolved.maxReceipts ?? DEFAULT_MAX_RECEIPTS
    this.retentionMs = resolved.retentionMs ?? DEFAULT_RETENTION_MS
    this.maxBytes = resolved.maxBytes ?? DEFAULT_MAX_BYTES
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
      assertGitStagedDiscardReceiptLedgerAvailable(this.loadError)
      const existing = this.entries.get(gitStagedDiscardReceiptKey(scope, operationId))
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error('Staged discard operation ID was reused')
        }
        return existing.promise
      }
      this.prepareNewOperation(operationId)
      assertGitStagedDiscardReceipt(pending, operationId, pending.affectedPaths)
      const entry = createGitStagedDiscardReceiptEntry(
        scope,
        operationId,
        fingerprint,
        this.now(),
        pending
      )
      this.entries.set(gitStagedDiscardReceiptKey(scope, operationId), entry)
      try {
        const removedKeys = this.evictForByteBound(entry)
        this.persist({ upsert: durableGitStagedDiscardReceiptEntry(entry), removedKeys })
      } catch (error) {
        this.entries.delete(gitStagedDiscardReceiptKey(scope, operationId))
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
    assertGitStagedDiscardReceiptLedgerAvailable(this.loadError)
    return this.entries.get(gitStagedDiscardReceiptKey(scope, operationId))?.receipt ?? null
  }

  reconcileAuthoritative(
    scope: string,
    operationId: string,
    value: GitStagedDiscardReceipt
  ): GitStagedDiscardReceipt | null {
    assertGitStagedDiscardReceiptLedgerAvailable(this.loadError)
    const entry = this.entries.get(gitStagedDiscardReceiptKey(scope, operationId))
    if (!entry) {
      return null
    }
    return this.settle(entry, value, true)
  }

  private settle(
    entry: GitStagedDiscardReceiptEntry,
    value: GitStagedDiscardReceipt,
    allowInterruptedReconciliation = false
  ): GitStagedDiscardReceipt {
    const receipt = assertGitStagedDiscardReceipt(
      value,
      entry.operationId,
      entry.receipt.affectedPaths
    )
    if (
      entry.receipt.state !== 'pending' &&
      !(allowInterruptedReconciliation && isInterruptedGitStagedDiscardReceipt(entry.receipt))
    ) {
      if (receipt.state === 'pending' || sameGitStagedDiscardReceipt(entry.receipt, receipt)) {
        return entry.receipt
      }
      throw new Error('The Git owner returned contradictory staged discard settlements')
    }
    entry.receipt = receipt
    entry.promise = Promise.resolve(receipt)
    this.entries.set(gitStagedDiscardReceiptKey(entry.scope, entry.operationId), entry)
    const removedKeys = this.evictForByteBound(entry)
    this.persist({ upsert: durableGitStagedDiscardReceiptEntry(entry), removedKeys })
    return receipt
  }

  private prepareNewOperation(operationId: string): void {
    const now = this.now()
    this.evictExpired(now)
    const timestamp = gitStagedDiscardOperationTimestamp(operationId)
    if (this.retiredSkewedOperationIds.has(operationId)) {
      throw new Error('Staged discard operation is outside the replay window')
    }
    if (timestamp === null && this.rejectUnknownLegacyOperationIds) {
      throw new Error('This staged discard operation predates the retained replay window')
    }
    if (timestamp !== null && timestamp <= this.retiredOperationTimestamp) {
      throw new Error('Staged discard operation is outside the replay window')
    }
    const removedKeys: string[] = []
    while (this.entries.size >= this.maxReceipts) {
      const candidate = [...this.entries.entries()].find(
        ([, entry]) => entry.receipt.state !== 'pending' && this.canRetire(entry)
      )
      if (!candidate) {
        throw new Error('Too many staged discard operations are retained for safe replay')
      }
      const [key, entry] = candidate
      this.retireEntry(entry)
      this.entries.delete(key)
      removedKeys.push(key)
    }
    if (removedKeys.length > 0) {
      this.persist({ removedKeys })
    }
  }

  private evictExpired(now: number): void {
    const removedKeys: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.receipt.state === 'pending' || entry.createdAt > now - this.retentionMs) {
        continue
      }
      if (!this.retireEntry(entry)) {
        continue
      }
      this.entries.delete(key)
      removedKeys.push(key)
    }
    if (removedKeys.length > 0) {
      this.persist({ removedKeys })
    }
  }

  private evictForByteBound(newEntry?: GitStagedDiscardReceiptEntry): string[] {
    const removedKeys: string[] = []
    while (this.entries.bytes + this.retiredSkewedOperationIds.size * 130 > this.maxBytes) {
      const candidate = [...this.entries.entries()].find(
        ([, entry]) =>
          entry !== newEntry &&
          entry.receipt.state !== 'pending' &&
          (newEntry !== undefined || !isInterruptedGitStagedDiscardReceipt(entry.receipt)) &&
          this.canRetire(entry)
      )
      if (!candidate) {
        throw new Error('Staged discard operations exceed the retained byte bound')
      }
      const [key, entry] = candidate
      this.retireEntry(entry)
      this.entries.delete(key)
      removedKeys.push(key)
    }
    return removedKeys
  }

  private canRetire(entry: GitStagedDiscardReceiptEntry): boolean {
    const timestamp = gitStagedDiscardOperationTimestamp(entry.operationId)
    return (
      timestamp === null ||
      Math.abs(timestamp - entry.createdAt) <= MAX_TRUSTED_CLIENT_CLOCK_SKEW_MS ||
      this.retiredSkewedOperationIds.size < MAX_RETIRED_SKEWED_OPERATION_IDS
    )
  }

  private retireEntry(entry: GitStagedDiscardReceiptEntry): boolean {
    if (!this.canRetire(entry)) {
      return false
    }
    const timestamp = gitStagedDiscardOperationTimestamp(entry.operationId)
    if (timestamp === null) {
      this.rejectUnknownLegacyOperationIds = true
    } else if (Math.abs(timestamp - entry.createdAt) <= MAX_TRUSTED_CLIENT_CLOCK_SKEW_MS) {
      this.retiredOperationTimestamp = Math.max(this.retiredOperationTimestamp, timestamp)
    } else {
      this.retiredSkewedOperationIds.add(entry.operationId)
    }
    return true
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
      const snapshot = parseGitStagedDiscardReceiptLedgerSnapshot(value)
      if (snapshot.entries.length > this.maxReceipts) {
        throw new Error('Staged discard ledger exceeds its retention bound')
      }
      this.rejectUnknownLegacyOperationIds = snapshot.rejectUnknownLegacyOperationIds
      this.retiredOperationTimestamp = snapshot.retiredOperationTimestamp
      for (const operationId of snapshot.retiredSkewedOperationIds ?? []) {
        this.retiredSkewedOperationIds.add(operationId)
      }
      let recoveredPending = false
      for (const durable of snapshot.entries) {
        const receipt =
          durable.receipt.state === 'pending'
            ? interruptedGitStagedDiscardReceipt(durable.operationId, durable.receipt.affectedPaths)
            : durable.receipt
        recoveredPending ||= receipt !== durable.receipt
        const entry = { ...durable, receipt, promise: Promise.resolve(receipt) }
        this.entries.set(gitStagedDiscardReceiptKey(entry.scope, entry.operationId), entry)
      }
      this.evictExpired(this.now())
      const removedKeys = this.evictForByteBound()
      if (recoveredPending) {
        this.storage.save(this.snapshot())
      } else if (removedKeys.length > 0) {
        this.persist({ removedKeys })
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error('Invalid staged discard ledger')
    }
  }

  private snapshot(): GitStagedDiscardReceiptLedgerSnapshot {
    return createGitStagedDiscardReceiptLedgerSnapshot(
      this.entries.values(),
      this.rejectUnknownLegacyOperationIds,
      this.retiredOperationTimestamp,
      this.retiredSkewedOperationIds
    )
  }

  private persist(
    change: Pick<GitStagedDiscardReceiptLedgerChange, 'upsert' | 'removedKeys'>
  ): void {
    const snapshot = this.snapshot()
    persistGitStagedDiscardReceiptLedger(
      this.storage,
      {
        ...change,
        rejectUnknownLegacyOperationIds: this.rejectUnknownLegacyOperationIds,
        retiredOperationTimestamp: this.retiredOperationTimestamp,
        retiredSkewedOperationIds: [...this.retiredSkewedOperationIds]
      },
      snapshot
    )
  }
}
