import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  PTY_SESSION_INVENTORY_RETAINED_ID_LIMIT,
  type PtyListedSession,
  type PtySessionInventorySnapshot
} from '../../../../shared/pty-listed-session'

type ReconciliationInput = {
  snapshot: PtySessionInventorySnapshot
  lifecycleRevision: number
  removedAtRevision: Map<string, number>
  spawnedAtRevision: Map<string, number>
  currentKnownSessionIds: ReadonlySet<string>
  currentHostIdBySessionId: ReadonlyMap<string, ExecutionHostId>
}

export type ResourceSessionInventoryReconciliation = {
  liveSessions: PtyListedSession[]
  listedSessionIds: Set<string>
  knownSessionIds: Set<string>
  hostIdBySessionId: Map<string, ExecutionHostId>
  complete: boolean
}

export function reconcileResourceSessionInventory({
  snapshot,
  lifecycleRevision,
  removedAtRevision,
  spawnedAtRevision,
  currentKnownSessionIds,
  currentHostIdBySessionId
}: ReconciliationInput): ResourceSessionInventoryReconciliation {
  const listedSessions = snapshot.sessions.filter(
    ({ id }) => (removedAtRevision.get(id) ?? 0) <= lifecycleRevision
  )
  const liveSessions = listedSessions.slice()
  const listedSessionIds = new Set(listedSessions.map(({ id }) => id))
  const knownSessionIds = new Set(listedSessionIds)
  const hasHostScopeMetadata =
    Array.isArray(snapshot.queriedHostIds) &&
    Array.isArray(snapshot.respondingHostIds) &&
    Array.isArray(snapshot.unavailableHostIds) &&
    snapshot.hostIdBySessionId !== null &&
    typeof snapshot.hostIdBySessionId === 'object'
  const queriedHostIds = new Set(
    hasHostScopeMetadata ? snapshot.queriedHostIds : ([] as ExecutionHostId[])
  )
  const respondingHostIds = new Set(
    hasHostScopeMetadata ? snapshot.respondingHostIds : ([] as ExecutionHostId[])
  )
  const unavailableHostIds = hasHostScopeMetadata ? snapshot.unavailableHostIds : []
  const retainedHostIdBySessionId = new Map<string, ExecutionHostId>()
  let retainedSessionIdCount = 0
  for (const [rawHostId, retainedSessionIds] of Object.entries(
    snapshot.retainedSessionIdsByHost ?? {}
  )) {
    const hostId = unavailableHostIds.find((candidate) => candidate === rawHostId)
    if (!hostId || !Array.isArray(retainedSessionIds)) {
      continue
    }
    for (const sessionId of retainedSessionIds) {
      if (retainedSessionIdCount >= PTY_SESSION_INVENTORY_RETAINED_ID_LIMIT) {
        break
      }
      if (
        typeof sessionId !== 'string' ||
        listedSessionIds.has(sessionId) ||
        (removedAtRevision.get(sessionId) ?? 0) > lifecycleRevision
      ) {
        continue
      }
      retainedSessionIdCount += 1
      knownSessionIds.add(sessionId)
      retainedHostIdBySessionId.set(sessionId, hostId)
      liveSessions.push({
        id: sessionId,
        cwd: '',
        title: sessionId,
        agentOwnership: 'unknown'
      })
    }
  }
  const complete =
    hasHostScopeMetadata &&
    snapshot.complete &&
    unavailableHostIds.length === 0 &&
    Array.from(queriedHostIds).every((hostId) => respondingHostIds.has(hostId))
  const hostIdBySessionId = new Map<string, ExecutionHostId>()
  for (const { id } of liveSessions) {
    const listedHostId = Object.hasOwn(snapshot.hostIdBySessionId, id)
      ? snapshot.hostIdBySessionId[id]
      : undefined
    const hostId =
      listedHostId ?? retainedHostIdBySessionId.get(id) ?? currentHostIdBySessionId.get(id)
    if (hostId) {
      hostIdBySessionId.set(id, hostId)
    }
  }
  // Each responding host is authoritative only for its own absent IDs.
  // Unknown or unavailable scopes stay known until a later scoped snapshot.
  for (const id of currentKnownSessionIds) {
    const hostId = currentHostIdBySessionId.get(id)
    const canPrune = hostId ? respondingHostIds.has(hostId) : complete
    if (!canPrune) {
      knownSessionIds.add(id)
      if (hostId) {
        hostIdBySessionId.set(id, hostId)
      }
    }
  }
  for (const [id, spawnedRevision] of spawnedAtRevision) {
    if (spawnedRevision > lifecycleRevision && (removedAtRevision.get(id) ?? 0) < spawnedRevision) {
      knownSessionIds.add(id)
      const hostId = currentHostIdBySessionId.get(id)
      if (hostId) {
        hostIdBySessionId.set(id, hostId)
      }
    }
  }
  // Markers at or before this request are now settled by its scoped authority.
  for (const [id, removedRevision] of removedAtRevision) {
    if (removedRevision <= lifecycleRevision) {
      removedAtRevision.delete(id)
    }
  }
  for (const [id, spawnedRevision] of spawnedAtRevision) {
    if (spawnedRevision <= lifecycleRevision) {
      spawnedAtRevision.delete(id)
    }
  }
  return {
    liveSessions,
    listedSessionIds,
    knownSessionIds,
    hostIdBySessionId,
    complete
  }
}
