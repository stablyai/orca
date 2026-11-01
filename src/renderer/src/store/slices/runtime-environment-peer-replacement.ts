import {
  getOrcadSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'

type CatalogEnvironment = Pick<
  PublicKnownRuntimeEnvironment,
  'id' | 'createdAt' | 'pairingRevision' | 'orcadDeployment' | 'hostKeyFingerprint'
>

/** Ids whose pairing rotated since the previous catalog. */
export function replacedRuntimeEnvironmentIds(
  previous: readonly CatalogEnvironment[],
  next: readonly CatalogEnvironment[]
): string[] {
  const previousById = new Map(previous.map((environment) => [environment.id, environment]))
  return next
    .filter((environment) => {
      const before = previousById.get(environment.id)
      return before !== undefined && pairingRevisionOf(before) !== pairingRevisionOf(environment)
    })
    .map((environment) => environment.id)
}

// Re-pairs of a managed server whose host key was not yet known: the host key and pairing it had before.
const deferredHostKeyById = new Map<string, { hostKey: string | null; revision: number | null }>()

export function resetDeferredPeerChecksForTests(): void {
  deferredHostKeyById.clear()
}

function sameRegistration(
  before: CatalogEnvironment | undefined,
  after: CatalogEnvironment | undefined
): boolean {
  // Hand-paired replacement requires both saved keys; without them identity cannot be proven.
  if (before && after && !before.orcadDeployment && !after.orcadDeployment) {
    return Boolean(before.hostKeyFingerprint && after.hostKeyFingerprint)
  }
  // Why SSH only: a WSL deployment takes the stricter re-pair path until its host identity lands.
  const left = before && getOrcadSshDeployment(before)
  const right = after && getOrcadSshDeployment(after)
  return Boolean(
    left &&
    right &&
    left.sshTargetId === right.sshTargetId &&
    left.sshTargetGeneration === right.sshTargetGeneration
  )
}

function pairingRevisionOf(environment: CatalogEnvironment | undefined): number | null {
  return environment ? (environment.pairingRevision ?? environment.createdAt) : null
}

export type SameHostPairingRotation = { id: string; fromRevision: number; toRevision: number }
export type PendingPairingRotation = { id: string; fromRevision: number }

/** Retire changed machines; continue managed SSH re-pairs only with matching proven host keys and registration. Defer unknown keys: registration alone survives reinstalls/retargeting. sameHost/pending carry the prior pairing. */
export function classifyPeerReplacements(
  previous: readonly CatalogEnvironment[],
  next: readonly CatalogEnvironment[],
  replacedIds: readonly string[]
): {
  retired: string[]
  sameHost: SameHostPairingRotation[]
  pending: PendingPairingRotation[]
} {
  const nextById = new Map(next.map((environment) => [environment.id, environment]))
  const retired: string[] = []
  const sameHost: SameHostPairingRotation[] = []
  const recordSameHost = (id: string, fromRevision: number | null): void => {
    const toRevision = pairingRevisionOf(nextById.get(id))
    if (fromRevision !== null && toRevision !== null) {
      sameHost.push({ id, fromRevision, toRevision })
    }
  }
  for (const id of replacedIds) {
    const before = previous.find((environment) => environment.id === id)
    const after = nextById.get(id)
    if (!sameRegistration(before, after)) {
      deferredHostKeyById.delete(id)
      retired.push(id)
      continue
    }
    const deferred = deferredHostKeyById.get(id)
    const beforeKey = before?.hostKeyFingerprint ?? deferred?.hostKey ?? null
    const fromRevision = deferred ? deferred.revision : pairingRevisionOf(before)
    const afterKey = after?.hostKeyFingerprint
    if (beforeKey && afterKey) {
      deferredHostKeyById.delete(id)
      if (beforeKey !== afterKey) {
        retired.push(id)
      } else {
        recordSameHost(id, fromRevision)
      }
      continue
    }
    deferredHostKeyById.set(id, { hostKey: beforeKey, revision: fromRevision })
  }
  for (const [id, deferred] of deferredHostKeyById) {
    const after = nextById.get(id)
    if (replacedIds.includes(id) || !after?.hostKeyFingerprint) {
      if (!after) {
        deferredHostKeyById.delete(id)
      }
      continue
    }
    deferredHostKeyById.delete(id)
    const before = previous.find((environment) => environment.id === id)
    if (
      !sameRegistration(before, after) ||
      (deferred.hostKey && deferred.hostKey !== after.hostKeyFingerprint)
    ) {
      retired.push(id)
    } else if (deferred.hostKey) {
      recordSameHost(id, deferred.revision)
    }
  }
  // Why a known prior key only: without one the re-pair can never be proven, so nothing waits on it.
  const pending = [...deferredHostKeyById].flatMap(([id, deferred]) =>
    deferred.hostKey !== null && deferred.revision !== null
      ? [{ id, fromRevision: deferred.revision }]
      : []
  )
  return { retired, sameHost, pending }
}
