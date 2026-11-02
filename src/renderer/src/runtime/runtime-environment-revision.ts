const revisionByEnvironmentId = new Map<string, number>()
// Pairings proven to continue the same machine: old revision → the revision that replaced it.
const continuedRevisionsByEnvironmentId = new Map<string, Map<number, number>>()
// Re-pairs whose host identity is not decided yet: id → the pairing they may continue.
const pendingContinuationByEnvironmentId = new Map<string, number>()
const retirementListeners = new Set<(environmentIds: readonly string[]) => void>()
const revisionChangeListeners = new Set<(environmentIds: readonly string[]) => void>()

export type RuntimeEnvironmentContinuity = {
  /** Ids now naming a different machine. */
  retired: readonly string[]
  /** Re-pairs proven to be the same machine (same registration and host key). */
  sameHost: readonly { id: string; fromRevision: number; toRevision: number }[]
  /** Re-pairs not yet proven either way, with the pairing they may continue. */
  pending?: readonly { id: string; fromRevision: number }[]
}

export function replaceRuntimeEnvironmentRevisions(
  environments: readonly { id: string; createdAt: number; pairingRevision?: number }[],
  continuity: RuntimeEnvironmentContinuity = { retired: [], sameHost: [] }
): void {
  const previous = new Map(revisionByEnvironmentId)
  const nextIds = new Set(environments.map((environment) => environment.id))
  const retired = new Set([
    ...continuity.retired,
    ...[...previous.keys()].filter((id) => !nextIds.has(id))
  ])
  for (const id of retired) {
    continuedRevisionsByEnvironmentId.delete(id)
  }
  // Fence old transports before publishing replacement credentials so retries cannot authenticate to another machine.
  if (retired.size > 0) {
    for (const listener of retirementListeners) {
      listener([...retired])
    }
  }
  for (const { id, fromRevision, toRevision } of continuity.sameHost) {
    if (fromRevision === toRevision || retired.has(id)) {
      continue
    }
    const continued = continuedRevisionsByEnvironmentId.get(id) ?? new Map<number, number>()
    continued.set(fromRevision, toRevision)
    continuedRevisionsByEnvironmentId.set(id, continued)
  }
  pendingContinuationByEnvironmentId.clear()
  for (const { id, fromRevision } of continuity.pending ?? []) {
    if (nextIds.has(id) && !retired.has(id)) {
      pendingContinuationByEnvironmentId.set(id, fromRevision)
    }
  }
  revisionByEnvironmentId.clear()
  for (const environment of environments) {
    revisionByEnvironmentId.set(
      environment.id,
      environment.pairingRevision ?? environment.createdAt
    )
  }
  const changed = [...previous].flatMap(([id, revision]) =>
    retired.has(id) || revisionByEnvironmentId.get(id) === revision ? [] : [id]
  )
  if (changed.length > 0) {
    for (const listener of revisionChangeListeners) {
      listener(changed)
    }
  }
}

/** Fires, before the new revisions are published, with ids removed or now naming another machine. */
export function onRuntimeEnvironmentsRetired(
  listener: (environmentIds: readonly string[]) => void
): () => void {
  retirementListeners.add(listener)
  return () => retirementListeners.delete(listener)
}

/** Fires with the ids still present whose saved pairing moved. */
export function onRuntimeEnvironmentRevisionsChanged(
  listener: (environmentIds: readonly string[]) => void
): () => void {
  revisionChangeListeners.add(listener)
  return () => revisionChangeListeners.delete(listener)
}

export function getRuntimeEnvironmentRevision(environmentId: string): number | undefined {
  return revisionByEnvironmentId.get(environmentId)
}

/** Selected catalog projection also changes when a pending host key is proved at the same revision. */
export function runtimeEnvironmentContinuityStamp(environmentId: string): string {
  return JSON.stringify([
    revisionByEnvironmentId.get(environmentId),
    pendingContinuationByEnvironmentId.get(environmentId)
  ])
}

/**
 * The newest pairing proven to be the same machine as `revision`. A holder of an older pairing may
 * follow a same-host rotation, but never a re-pair whose host identity is different or unresolved.
 */
export function resolveContinuedRuntimeEnvironmentRevision(
  environmentId: string,
  revision: number | undefined
): number | undefined {
  if (revision === undefined) {
    return getRuntimeEnvironmentRevision(environmentId)
  }
  const continued = continuedRevisionsByEnvironmentId.get(environmentId)
  let current = revision
  const seen = new Set<number>()
  while (continued?.has(current) && !seen.has(current)) {
    seen.add(current)
    current = continued.get(current) ?? current
  }
  return current
}

/** True while a re-pair that may continue `revision` is still waiting for its host identity. */
export function isRuntimeEnvironmentContinuationPending(
  environmentId: string,
  revision: number | undefined
): boolean {
  return (
    revision !== undefined && pendingContinuationByEnvironmentId.get(environmentId) === revision
  )
}

export function captureRuntimeEnvironmentRequestRevision(
  environmentId: string,
  expectedRevision?: number
): number | undefined {
  // Why: callers capture before awaits so a same-id re-pair cannot retarget their request.
  return expectedRevision ?? getRuntimeEnvironmentRevision(environmentId)
}
