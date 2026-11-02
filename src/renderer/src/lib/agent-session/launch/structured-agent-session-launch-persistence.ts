import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  validRecord,
  parseStructuredLaunchSurfaceAddress,
  type StructuredAgentLaunchPersistedRecord
} from './structured-agent-session-launch-record'

import { parseStructuredLaunchSeedOptions } from '../../../../../shared/native-chat/input/native-chat-session-option-defaults'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'

const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'
const TOMBSTONE_STORAGE_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'
const records = new Map<string, StructuredAgentLaunchPersistedRecord>()
const tombstones = new Map<string, ExecutionHostId>()
/** When each paired-host tombstone was written, so one whose host never answers again expires. */
const remoteTombstoneCancelledAt = new Map<string, number>()
const REMOTE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
let loaded = false
// Writes inside a batch update the records at once and save them once, at the batch's end.
let batchDepth = 0
let batchDirty = false
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
    if (Array.isArray(stored)) {
      for (const value of stored) {
        if (validRecord(value)) {
          const seedOptions = parseStructuredLaunchSeedOptions(
            'seedOptions' in value ? value.seedOptions : undefined
          )
          const surfaceAddress = parseStructuredLaunchSurfaceAddress(
            'surfaceAddress' in value ? value.surfaceAddress : undefined
          )
          const { seedOptions: _stored, surfaceAddress: _address, ...rest } = value
          records.set(value.sessionId, {
            ...rest,
            ...(surfaceAddress ? { surfaceAddress } : {}),
            ...(seedOptions ? { seedOptions } : {}),
            executionHostId:
              parseExecutionHostId(value.executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID,
            // A renderer reload cannot prove a pending request was delivered.
            lifecycle: value.lifecycle === 'pending' ? 'visibility-unknown' : value.lifecycle
          })
        }
      }
    }
    const storedTombstones = JSON.parse(localStorage.getItem(TOMBSTONE_STORAGE_KEY) ?? '[]')
    if (Array.isArray(storedTombstones)) {
      for (const value of storedTombstones) {
        loadTombstone(value)
      }
    }
  } catch {
    console.warn('[structured-agent-launch] could not read persisted launch state')
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

/** A bare id is a local chat's tombstone, the only kind older builds wrote and still read. */
function loadTombstone(value: unknown): void {
  if (validSessionId(value)) {
    tombstones.set(value, LOCAL_EXECUTION_HOST_ID)
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }
  const sessionId = 'sessionId' in value ? value.sessionId : undefined
  const host = parseExecutionHostId(
    'executionHostId' in value && typeof value.executionHostId === 'string'
      ? value.executionHostId
      : null
  )
  const cancelledAt = 'cancelledAt' in value ? value.cancelledAt : undefined
  if (
    !validSessionId(sessionId) ||
    !host ||
    typeof cancelledAt !== 'number' ||
    Date.now() - cancelledAt > REMOTE_TOMBSTONE_TTL_MS
  ) {
    return
  }
  tombstones.set(sessionId, host.id)
  remoteTombstoneCancelledAt.set(sessionId, cancelledAt)
}

function serializeTombstone(sessionId: string, executionHostId: ExecutionHostId): unknown {
  return executionHostId === LOCAL_EXECUTION_HOST_ID
    ? sessionId
    : {
        sessionId,
        executionHostId,
        cancelledAt: remoteTombstoneCancelledAt.get(sessionId) ?? Date.now()
      }
}

function writeRecords(): void {
  batchSlotIndex = undefined
  if (batchDepth > 0) {
    batchDirty = true
    return
  }
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
            serializeTombstone(sessionId, executionHostId)
          )
        )
      )
    }
  } catch {
    // Recovery bookkeeping must never prevent close.
    console.warn('[structured-agent-launch] could not persist cancellation tombstones')
  }
}

/** Runs `update` with its record writes saved once, when it ends; a write outside any batch is
 *  saved before it returns, as a launch's row must be before its host is asked. */
export function batchStructuredAgentLaunchRecordWrites(update: () => void): void {
  batchDepth += 1
  try {
    update()
  } finally {
    batchDepth -= 1
    if (batchDepth === 0) {
      batchSlotIndex = undefined
      if (batchDirty) {
        batchDirty = false
        writeRecords()
      }
    }
  }
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
    const keys = [slotKey(address.worktreeId)]
    if (address.targetGroupId) {
      keys.push(slotKey(address.worktreeId, address.targetGroupId))
    }
    for (const key of keys) {
      const ids = index.get(key)
      if (ids) {
        ids.add(tabId)
      } else {
        index.set(key, new Set([tabId]))
      }
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
  records.delete(sessionId)
  if (!tombstones.has(sessionId)) {
    tombstones.set(sessionId, executionHostId)
    if (executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      remoteTombstoneCancelledAt.set(sessionId, Date.now())
    }
  }
  writeRecords()
  writeTombstones()
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
  batchSlotIndex = undefined
  tombstones.clear()
  remoteTombstoneCancelledAt.clear()
  loaded = false
}
