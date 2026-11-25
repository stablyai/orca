export type RuntimeEnvironmentRegistration = Readonly<{ revision: number }>

const registrations = new Map<string, RuntimeEnvironmentRegistration>()
// Pairings proven to continue the same machine: old revision → the revision that replaced it.
const continuedRevisionsByEnvironmentId = new Map<string, Map<number, number>>()
// Re-pairs whose host identity is not decided yet: id → the pairing they may continue.
const pendingContinuationByEnvironmentId = new Map<string, number>()
const retirementListeners = new Set<(environmentIds: readonly string[]) => void>()
const revisionChangeListeners = new Set<(environmentIds: readonly string[]) => void>()
const publicationListeners = new Set<() => void>()

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
  const previous = new Map(registrations)
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
  registrations.clear()
  for (const environment of environments) {
    const { id } = environment
    const previousRegistration = previous.get(id)
    const revision = environment.pairingRevision ?? environment.createdAt
    registrations.set(
      id,
      previousRegistration?.revision === revision && !retired.has(id)
        ? previousRegistration
        : { revision }
    )
  }
  const changed = [...previous].flatMap(([id, { revision }]) =>
    retired.has(id) || registrations.get(id)?.revision === revision ? [] : [id]
  )
  if (changed.length > 0) {
    for (const listener of revisionChangeListeners) {
      listener(changed)
    }
  }
  publicationListeners.forEach((listener) => listener())
}

/** Fires after the registry is populated, including removed or newly registered environments. */
export function onRuntimeEnvironmentRevisionsPublished(listener: () => void): () => void {
  publicationListeners.add(listener)
  return () => publicationListeners.delete(listener)
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
  return registrations.get(environmentId)?.revision
}

/** Identity survives equal-revision publications, but never removal or a pairing transition. */
export function getRuntimeEnvironmentRegistration(
  environmentId: string
): RuntimeEnvironmentRegistration | undefined {
  return registrations.get(environmentId)
}

/**
 * The registrations `environmentIds` hold right now. A publisher takes this in the same turn it
 * publishes, so a later publication (even of an equal revision after a removal) cannot lend it its identity.
 */
export function snapshotRuntimeEnvironmentRegistrations(
  environmentIds: readonly string[]
): ReadonlyMap<string, RuntimeEnvironmentRegistration> {
  return new Map(
    environmentIds.flatMap((id) => {
      const registration = registrations.get(id)
      return registration ? [[id, registration] as const] : []
    })
  )
}

/** Selected catalog projection also changes when a pending host key is proved at the same revision. */
export function runtimeEnvironmentContinuityStamp(environmentId: string): string {
  return JSON.stringify([
    getRuntimeEnvironmentRevision(environmentId),
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
