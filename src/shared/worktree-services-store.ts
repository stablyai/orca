import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from './secure-file'
import {
  WorktreeServicesStoreSchema,
  type WorktreeServicesRecord,
  type WorktreeServicesStore
} from './worktree-services'

const WORKTREE_SERVICES_FILE = 'orca-worktree-services.json'

export function getWorktreeServicesStorePath(userDataPath: string): string {
  return join(userDataPath, WORKTREE_SERVICES_FILE)
}

function readStore(userDataPath: string): WorktreeServicesStore {
  const path = getWorktreeServicesStorePath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, records: [] }
  }
  hardenExistingSecureFile(path)
  try {
    return WorktreeServicesStoreSchema.parse(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return { version: 1, records: [] }
  }
}

function writeStore(userDataPath: string, store: WorktreeServicesStore): void {
  writeSecureJsonFile(getWorktreeServicesStorePath(userDataPath), store)
}

export function listWorktreeServicesRecords(userDataPath: string): WorktreeServicesRecord[] {
  return readStore(userDataPath).records
}

export function getWorktreeServicesRecord(
  userDataPath: string,
  worktreeId: string
): WorktreeServicesRecord | null {
  return readStore(userDataPath).records.find((r) => r.worktreeId === worktreeId) ?? null
}

export function allocateServiceSlot(userDataPath: string): number {
  const used = new Set(readStore(userDataPath).records.map((r) => r.slot))
  let slot = 0
  while (used.has(slot)) {
    slot++
  }
  return slot
}

export function upsertWorktreeServicesRecord(
  userDataPath: string,
  record: WorktreeServicesRecord
): WorktreeServicesRecord {
  const store = readStore(userDataPath)
  const records = store.records.filter((r) => r.worktreeId !== record.worktreeId)
  records.push(record)
  writeStore(userDataPath, { version: 1, records })
  return record
}

export function removeWorktreeServicesRecord(
  userDataPath: string,
  worktreeId: string
): WorktreeServicesRecord | null {
  const store = readStore(userDataPath)
  const removed = store.records.find((r) => r.worktreeId === worktreeId) ?? null
  if (removed) {
    writeStore(userDataPath, {
      version: 1,
      records: store.records.filter((r) => r.worktreeId !== worktreeId)
    })
  }
  return removed
}
