import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export type StructuredAgentLaunchPersistedLifecycle = 'pending' | 'visibility-unknown' | 'failed'

export type StructuredAgentLaunchPersistedRecord = {
  sessionId: string
  agent: AgentSessionHandleProvider
  lifecycle: StructuredAgentLaunchPersistedLifecycle
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
  target?: RuntimeClientTarget
}

const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'
const TOMBSTONE_STORAGE_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'
const records = new Map<string, StructuredAgentLaunchPersistedRecord>()
const tombstones = new Set<string>()
const cancellationTargets = new Map<string, RuntimeClientTarget>()
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
  const target = 'target' in value ? value.target : undefined
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    (agent === 'claude' || agent === 'codex') &&
    (lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed') &&
    typeof clientOperationId === 'string' &&
    typeof payloadFingerprint === 'string' &&
    (expectedRuntimeFence === null || typeof expectedRuntimeFence === 'number') &&
    (target === undefined || validTarget(target)) &&
    (resumeFrom === undefined ||
      (typeof resumeFrom === 'object' &&
        resumeFrom !== null &&
        'providerSessionId' in resumeFrom &&
        typeof resumeFrom.providerSessionId === 'string'))
  )
}

function validTarget(value: unknown): value is RuntimeClientTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'local' ||
      (value.kind === 'environment' &&
        'environmentId' in value &&
        typeof value.environmentId === 'string' &&
        value.environmentId.trim().length > 0 &&
        (!('expectedEnvironmentPairingRevision' in value) ||
          value.expectedEnvironmentPairingRevision === undefined ||
          (typeof value.expectedEnvironmentPairingRevision === 'number' &&
            Number.isFinite(value.expectedEnvironmentPairingRevision)))))
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
        } else if (
          value &&
          typeof value === 'object' &&
          typeof value.sessionId === 'string' &&
          value.sessionId.length > 0 &&
          value.sessionId.length <= 256 &&
          validTarget(value.target)
        ) {
          tombstones.add(value.sessionId)
          cancellationTargets.set(value.sessionId, value.target)
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
      localStorage.setItem(
        TOMBSTONE_STORAGE_KEY,
        JSON.stringify(
          [...tombstones].map((sessionId) => {
            const target = cancellationTargets.get(sessionId)
            return target?.kind === 'environment' ? { sessionId, target } : sessionId
          })
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
  target?: RuntimeClientTarget
): void {
  load()
  const owner = target ?? records.get(sessionId)?.target
  if (owner) {
    cancellationTargets.set(sessionId, owner)
  }
  records.delete(sessionId)
  tombstones.add(sessionId)
  writeRecords()
  writeTombstones()
}

export function structuredAgentLaunchCancellationBelongsTo(
  sessionId: string,
  target: RuntimeClientTarget
): boolean {
  load()
  const owner = cancellationTargets.get(sessionId) ?? { kind: 'local' }
  return (
    owner.kind === target.kind &&
    (owner.kind === 'local' ||
      (target.kind === 'environment' &&
        owner.environmentId === target.environmentId &&
        (owner.expectedEnvironmentPairingRevision === undefined ||
          owner.expectedEnvironmentPairingRevision === target.expectedEnvironmentPairingRevision)))
  )
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
  cancellationTargets.delete(sessionId)
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
      cancellationTargets.delete(sessionId)
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
  cancellationTargets.clear()
  loaded = false
}
