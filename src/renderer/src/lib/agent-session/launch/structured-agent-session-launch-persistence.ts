import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { StructuredAgentLaunchPersistedRecord } from './structured-agent-session-launch-record'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../../shared/execution-host'
import {
  readSavedLaunchRecord,
  readSavedLaunchTombstone,
  savedLaunchTombstone
} from './structured-agent-session-launch-journal-codec'

const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'
const TOMBSTONE_STORAGE_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'
const records = new Map<string, StructuredAgentLaunchPersistedRecord>()
const tombstones = new Map<string, ExecutionHostId>()
/** When each paired-host tombstone was written, so one whose host never answers again expires. */
const remoteTombstoneCancelledAt = new Map<string, number>()
let loaded = false
// Bumped on every change to the records, so an index derived from them knows when it is stale.
let recordsRevision = 0
// Writes inside a batch update the records and tombstones at once and save each changed journal
// once, at the batch's end.
let batchDepth = 0
let batchRecordsDirty = false
let batchTombstonesDirty = false
// Slot ids by workspace and group, indexed in one pass the first time a batch reads them and
// dropped when a record changes: a batch drawing tabs in many workspaces scans the records once.
let batchSlotIndex: Map<string, Set<string>> | undefined
const NO_SLOT_IDS: ReadonlySet<string> = new Set()

function load(): void {
  if (loaded) {
    return
  }
  loaded = true
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    const stored = JSON.parse(localStorage.getItem(LAUNCH_STORAGE_KEY) ?? '[]')
    for (const value of Array.isArray(stored) ? stored : []) {
      const record = readSavedLaunchRecord(value)
      if (record) {
        records.set(record.sessionId, record)
      }
    }
    const storedTombstones = JSON.parse(localStorage.getItem(TOMBSTONE_STORAGE_KEY) ?? '[]')
    for (const value of Array.isArray(storedTombstones) ? storedTombstones : []) {
      const tombstone = readSavedLaunchTombstone(value)
      if (tombstone) {
        tombstones.set(tombstone.sessionId, tombstone.executionHostId)
        if (tombstone.cancelledAt !== undefined) {
          remoteTombstoneCancelledAt.set(tombstone.sessionId, tombstone.cancelledAt)
        }
      }
    }
  } catch {
    console.warn('[structured-agent-launch] could not read persisted launch state')
  }
}

function writeRecords(): void {
  batchSlotIndex = undefined
  recordsRevision += 1
  if (batchDepth > 0) {
    batchRecordsDirty = true
    return
  }
  saveRecords()
}

function saveRecords(): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    if (records.size === 0) {
      localStorage.removeItem(LAUNCH_STORAGE_KEY)
    } else {
      localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify([...records.values()]))
    }
  } catch {
    // Recovery bookkeeping must never prevent launch.
    console.warn('[structured-agent-launch] could not persist launch state')
  }
}

function writeTombstones(): void {
  if (batchDepth > 0) {
    batchTombstonesDirty = true
    return
  }
  saveTombstones()
}

function saveTombstones(): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    if (tombstones.size === 0) {
      localStorage.removeItem(TOMBSTONE_STORAGE_KEY)
    } else {
      localStorage.setItem(
        TOMBSTONE_STORAGE_KEY,
        JSON.stringify(
          [...tombstones].map(([sessionId, executionHostId]) =>
            savedLaunchTombstone(
              sessionId,
              executionHostId,
              remoteTombstoneCancelledAt.get(sessionId)
            )
          )
        )
      )
    }
  } catch {
    // Recovery bookkeeping must never prevent close.
    console.warn('[structured-agent-launch] could not persist cancellation tombstones')
  }
}

/** Runs `update` with its record and tombstone writes saved once each, when it ends; a write
 *  outside any batch is saved before it returns, as a launch's row must be before its host is
 *  asked. Cancellations take effect in memory at once. Tombstones are saved before the rows they
 *  retire, so a save cut short between the two leaves a row its tombstone still ends. */
export function batchStructuredAgentLaunchRecordWrites<T>(update: () => T): T {
  batchDepth += 1
  try {
    return update()
  } finally {
    batchDepth -= 1
    if (batchDepth === 0) {
      batchSlotIndex = undefined
      if (batchTombstonesDirty) {
        batchTombstonesDirty = false
        saveTombstones()
      }
      if (batchRecordsDirty) {
        batchRecordsDirty = false
        saveRecords()
      }
    }
  }
}

export function structuredAgentLaunchRecordsRevision(): number {
  load()
  return recordsRevision
}

export function readStructuredAgentLaunchRecords(): readonly StructuredAgentLaunchPersistedRecord[] {
  load()
  return [...records.values()]
}

function slotKey(worktreeId: string, groupId?: string): string {
  return `${worktreeId}\0${groupId ?? ''}`
}

function isLaunchSlot(record: StructuredAgentLaunchPersistedRecord): boolean {
  return record.executionHostId === 'local' && record.lifecycle !== 'failed'
}

function indexSlotIds(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const record of readStructuredAgentLaunchRecords()) {
    const address = record.surfaceAddress
    if (!address || !isLaunchSlot(record)) {
      continue
    }
    const tabId = structuredAgentSessionTabId(record.sessionId)
    for (const groupId of new Set([undefined, address.targetGroupId])) {
      const key = slotKey(address.worktreeId, groupId)
      index.set(key, (index.get(key) ?? new Set<string>()).add(tabId))
    }
  }
  return index
}

export function structuredLaunchSlotIds(worktreeId: string, groupId?: string): ReadonlySet<string> {
  if (batchDepth > 0) {
    batchSlotIndex ??= indexSlotIds()
    return batchSlotIndex.get(slotKey(worktreeId, groupId)) ?? NO_SLOT_IDS
  }
  return new Set(
    readStructuredAgentLaunchRecords().flatMap((record) =>
      isLaunchSlot(record) &&
      record.surfaceAddress?.worktreeId === worktreeId &&
      (!groupId || record.surfaceAddress.targetGroupId === groupId)
        ? [structuredAgentSessionTabId(record.sessionId)]
        : []
    )
  )
}

export function readStructuredAgentLaunchRecord(
  sessionId: string
): StructuredAgentLaunchPersistedRecord | undefined {
  load()
  return records.get(sessionId)
}

export function writeStructuredAgentLaunchRecord(
  record: StructuredAgentLaunchPersistedRecord
): void {
  load()
  records.set(record.sessionId, record)
  writeRecords()
}

export function updateStructuredAgentLaunchRecords(
  changes: Iterable<readonly [string, StructuredAgentLaunchPersistedRecord | null]>
): void {
  load()
  let changed = false
  for (const [sessionId, record] of changes) {
    if (record) {
      records.set(sessionId, record)
      changed = true
    } else if (records.delete(sessionId)) {
      changed = true
    }
  }
  if (changed) {
    writeRecords()
  }
}

export function deleteStructuredAgentLaunchRecord(sessionId: string): void {
  load()
  if (records.delete(sessionId)) {
    writeRecords()
  }
}

export function markStructuredAgentLaunchCancelledPersisted(
  sessionId: string,
  executionHostId: ExecutionHostId
): void {
  load()
  if (!tombstones.has(sessionId)) {
    tombstones.set(sessionId, executionHostId)
    if (executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      remoteTombstoneCancelledAt.set(sessionId, Date.now())
    }
    writeTombstones()
  }
  if (records.delete(sessionId)) {
    writeRecords()
  }
}

export function hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId: string): boolean {
  load()
  return tombstones.has(sessionId)
}

/** The cancelled sessions a host owns: only its inventory can prove one gone. */
export function readStructuredAgentLaunchCancellationTombstoneSessionIds(
  executionHostId?: ExecutionHostId
): readonly string[] {
  load()
  return [...tombstones]
    .filter(([, owner]) => executionHostId === undefined || owner === executionHostId)
    .map(([sessionId]) => sessionId)
}

export function retireStructuredAgentLaunchCancellationTombstonePersisted(
  sessionId: string
): boolean {
  load()
  const removed = tombstones.delete(sessionId)
  remoteTombstoneCancelledAt.delete(sessionId)
  if (removed) {
    writeTombstones()
  }
  return removed
}

/** Retires `executionHostId`'s tombstones its inventory no longer lists; other hosts' stay. */
export function retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted(
  publishedSessionIds: ReadonlySet<string>,
  executionHostId: ExecutionHostId
): boolean {
  load()
  let changed = false
  for (const [sessionId, owner] of tombstones) {
    if (owner === executionHostId && !publishedSessionIds.has(sessionId)) {
      tombstones.delete(sessionId)
      remoteTombstoneCancelledAt.delete(sessionId)
      changed = true
    }
  }
  if (changed) {
    writeTombstones()
  }
  return changed
}

export function resetStructuredAgentLaunchPersistenceForTests(): void {
  records.clear()
  recordsRevision += 1
  batchSlotIndex = undefined
  tombstones.clear()
  remoteTombstoneCancelledAt.clear()
  loaded = false
}
