import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'

export type StructuredAgentLaunchPersistedLifecycle = 'pending' | 'visibility-unknown' | 'failed'

export type StructuredAgentLaunchPersistedRecord = {
  sessionId: string
  agent: AgentSessionHandleProvider
  lifecycle: StructuredAgentLaunchPersistedLifecycle
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
}

const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'
const TOMBSTONE_STORAGE_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'
const records = new Map<string, StructuredAgentLaunchPersistedRecord>()
const tombstones = new Set<string>()
let loaded = false

function validRecord(value: unknown): value is StructuredAgentLaunchPersistedRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (
    !('sessionId' in value) ||
    !('agent' in value) ||
    !('lifecycle' in value) ||
    !('clientOperationId' in value) ||
    !('payloadFingerprint' in value) ||
    !('expectedRuntimeFence' in value)
  ) {
    return false
  }
  const {
    sessionId,
    agent,
    lifecycle,
    clientOperationId,
    payloadFingerprint,
    expectedRuntimeFence
  } = value
  const resumeFrom = 'resumeFrom' in value ? value.resumeFrom : undefined
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    (agent === 'claude' || agent === 'codex') &&
    (lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed') &&
    typeof clientOperationId === 'string' &&
    typeof payloadFingerprint === 'string' &&
    (expectedRuntimeFence === null || typeof expectedRuntimeFence === 'number') &&
    (resumeFrom === undefined ||
      (typeof resumeFrom === 'object' &&
        resumeFrom !== null &&
        'providerSessionId' in resumeFrom &&
        typeof resumeFrom.providerSessionId === 'string'))
  )
}

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
          records.set(value.sessionId, {
            ...value,
            // A renderer reload cannot prove a pending request was delivered.
            lifecycle: value.lifecycle === 'pending' ? 'visibility-unknown' : value.lifecycle
          })
        }
      }
    }
    const storedTombstones = JSON.parse(localStorage.getItem(TOMBSTONE_STORAGE_KEY) ?? '[]')
    if (Array.isArray(storedTombstones)) {
      for (const value of storedTombstones) {
        if (typeof value === 'string' && value.length > 0 && value.length <= 256) {
          tombstones.add(value)
        }
      }
    }
  } catch {
    console.warn('[structured-agent-launch] could not read persisted launch state')
  }
}

function writeRecords(): void {
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
    // Why: persistence is recovery bookkeeping and must never block a launch.
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
      localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify([...tombstones]))
    }
  } catch {
    // Why: persistence is recovery bookkeeping and must never block close.
    console.warn('[structured-agent-launch] could not persist cancellation tombstones')
  }
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

export function markStructuredAgentLaunchCancelledPersisted(sessionId: string): void {
  load()
  records.delete(sessionId)
  tombstones.add(sessionId)
  writeRecords()
  writeTombstones()
}

export function hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId: string): boolean {
  load()
  return tombstones.has(sessionId)
}

export function readStructuredAgentLaunchCancellationTombstoneSessionIds(): readonly string[] {
  load()
  return [...tombstones]
}

export function retireStructuredAgentLaunchCancellationTombstonePersisted(
  sessionId: string
): boolean {
  load()
  const removed = tombstones.delete(sessionId)
  if (removed) {
    writeTombstones()
  }
  return removed
}

export function retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted(
  publishedSessionIds: ReadonlySet<string>
): boolean {
  load()
  let changed = false
  for (const sessionId of tombstones) {
    if (!publishedSessionIds.has(sessionId)) {
      tombstones.delete(sessionId)
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
  tombstones.clear()
  loaded = false
}
