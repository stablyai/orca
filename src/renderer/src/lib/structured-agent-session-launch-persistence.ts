import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import { parseStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export type StructuredAgentLaunchPersistedLifecycle = 'pending' | 'visibility-unknown' | 'failed'

export type StructuredAgentLaunchPersistedRecord = {
  sessionId: string
  /** The host the chat was created on. Records written before paired hosts could hold a chat lack
   *  it and load as local, the only host a chat could then be launched on. */
  executionHostId: ExecutionHostId
  agent: AgentSessionHandleProvider
  lifecycle: StructuredAgentLaunchPersistedLifecycle
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
  /** A paired server's reported seed, which this machine cannot re-derive after a reload. */
  seedOptions?: Readonly<Record<string, string>>
  /** When a failed launch failed; records written by older builds lack it. */
  failedAt?: number
}

/** What survives a reload of an unpublished launch. */
export function structuredAgentLaunchRecordFor(
  intent: StructuredAgentSessionLaunchIntent,
  lifecycle: StructuredAgentLaunchPersistedLifecycle
): StructuredAgentLaunchPersistedRecord {
  const { envelope, resumeFrom } = intent.params
  // A local launch re-reads this machine's settings on reload; only a paired server's seed is kept.
  const pairedSeed = intent.target.kind === 'local' ? undefined : intent.seedOptions
  return {
    sessionId: intent.sessionId,
    executionHostId: intent.executionHostId,
    agent: intent.agent,
    lifecycle,
    clientOperationId: envelope.clientOperationId,
    payloadFingerprint: envelope.payloadFingerprint,
    expectedRuntimeFence: envelope.expectedRuntimeFence,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(pairedSeed ? { seedOptions: pairedSeed } : {})
  }
}

const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'
const TOMBSTONE_STORAGE_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'
const records = new Map<string, StructuredAgentLaunchPersistedRecord>()
/** Cancelled session id -> the host that owns it. */
const tombstones = new Map<string, ExecutionHostId>()
/** When each paired-host tombstone was written, so one whose host never answers again expires. */
const remoteTombstoneCancelledAt = new Map<string, number>()
const REMOTE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
let loaded = false

function validRecord(value: unknown): value is Omit<
  StructuredAgentLaunchPersistedRecord,
  'executionHostId'
> & {
  executionHostId?: string
} {
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
  const executionHostId = 'executionHostId' in value ? value.executionHostId : undefined
  const failedAt = 'failedAt' in value ? value.failedAt : undefined
  return (
    (executionHostId === undefined ||
      (typeof executionHostId === 'string' && parseExecutionHostId(executionHostId) !== null)) &&
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    (agent === 'claude' || agent === 'codex') &&
    (lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed') &&
    typeof clientOperationId === 'string' &&
    typeof payloadFingerprint === 'string' &&
    (expectedRuntimeFence === null || typeof expectedRuntimeFence === 'number') &&
    (failedAt === undefined || Number.isFinite(failedAt)) &&
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
          const seedOptions = parseStructuredLaunchSeedOptions(
            'seedOptions' in value ? value.seedOptions : undefined
          )
          const { seedOptions: _stored, ...rest } = value
          records.set(value.sessionId, {
            ...rest,
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
  tombstones.clear()
  remoteTombstoneCancelledAt.clear()
  loaded = false
}
