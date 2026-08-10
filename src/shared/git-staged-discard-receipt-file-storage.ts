import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeSync
} from 'node:fs'
import { hardenExistingSecureFile, writeSecureFile } from './secure-file'
import type {
  GitStagedDiscardReceiptLedgerChange,
  GitStagedDiscardReceiptLedgerSnapshot,
  GitStagedDiscardReceiptLedgerStorage
} from './git-staged-discard-receipt-ledger'

const JOURNAL_PREFIX = '\nORCA_GIT_STAGED_DISCARD_V1 '
const MAX_JOURNAL_CHANGES = 128
const MAX_JOURNAL_FILE_BYTES = 8 * 1024 * 1024

export class GitStagedDiscardReceiptFileStorage implements GitStagedDiscardReceiptLedgerStorage {
  private journalChanges = 0

  constructor(private readonly filePath: string) {}

  load(): unknown {
    if (!existsSync(this.filePath)) {
      return null
    }
    hardenExistingSecureFile(this.filePath)
    const contents = readFileSync(this.filePath, 'utf8')
    const firstRecord = contents.indexOf(JOURNAL_PREFIX)
    if (firstRecord < 0) {
      this.journalChanges = 0
      return JSON.parse(contents)
    }
    const snapshot = JSON.parse(
      contents.slice(0, firstRecord)
    ) as GitStagedDiscardReceiptLedgerSnapshot
    const records = contents.slice(firstRecord + JOURNAL_PREFIX.length).split(JOURNAL_PREFIX)
    this.journalChanges = 0
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      if (!record.endsWith('\n')) {
        if (index === records.length - 1) {
          break
        }
        throw new Error('Invalid staged discard receipt journal')
      }
      applyChange(snapshot, JSON.parse(record.slice(0, -1)))
      this.journalChanges += 1
    }
    return snapshot
  }

  save(snapshot: GitStagedDiscardReceiptLedgerSnapshot): void {
    writeSecureFile(this.filePath, JSON.stringify(snapshot))
    this.journalChanges = 0
  }

  append(
    change: GitStagedDiscardReceiptLedgerChange,
    snapshot: GitStagedDiscardReceiptLedgerSnapshot
  ): void {
    if (!existsSync(this.filePath)) {
      this.save(snapshot)
      return
    }
    hardenExistingSecureFile(this.filePath)
    const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
    const descriptor = openSync(this.filePath, flags)
    try {
      writeSync(descriptor, `${JOURNAL_PREFIX}${JSON.stringify(change)}\n`, undefined, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    this.journalChanges += 1
    if (
      this.journalChanges >= MAX_JOURNAL_CHANGES ||
      statSync(this.filePath).size > MAX_JOURNAL_FILE_BYTES
    ) {
      this.save(snapshot)
    }
  }
}

function applyChange(snapshot: GitStagedDiscardReceiptLedgerSnapshot, value: unknown): void {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid staged discard receipt journal')
  }
  const change = value as GitStagedDiscardReceiptLedgerChange
  if (
    typeof change.rejectUnknownLegacyOperationIds !== 'boolean' ||
    !Number.isSafeInteger(change.retiredOperationTimestamp) ||
    !Array.isArray(change.retiredSkewedOperationIds) ||
    (change.removedKeys !== undefined && !Array.isArray(change.removedKeys))
  ) {
    throw new Error('Invalid staged discard receipt journal')
  }
  const removed = new Set(change.removedKeys ?? [])
  snapshot.entries = snapshot.entries.filter(
    (entry) => !removed.has(entryKey(entry.scope, entry.operationId))
  )
  if (change.upsert) {
    const key = entryKey(change.upsert.scope, change.upsert.operationId)
    snapshot.entries = snapshot.entries.filter(
      (entry) => entryKey(entry.scope, entry.operationId) !== key
    )
    snapshot.entries.push(change.upsert)
  }
  snapshot.rejectUnknownLegacyOperationIds = change.rejectUnknownLegacyOperationIds
  snapshot.retiredOperationTimestamp = change.retiredOperationTimestamp
  snapshot.retiredSkewedOperationIds = change.retiredSkewedOperationIds
}

function entryKey(scope: string, operationId: string): string {
  return `${scope}\0${operationId}`
}
