import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

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
  const left = before?.orcadDeployment
  const right = after?.orcadDeployment
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

/**
 * `retired`: ids that now name a different machine, whose workspaces and tabs are retired. A managed
 * server re-pairs on every update and is the same machine while the host's key digest, which its
 * pairing handshake proves, is unchanged under the same SSH target registration. A registration
 * alone is no proof (a reinstall or a target that resolves elsewhere keeps it), so a re-pair whose
 * key is not known yet is decided later, once a catalog carries it, rather than purged on a guess.
 * `sameHost`: re-pairs proven to be the same machine, with the pairing they continue. Re-pairs in
 * neither list are still unresolved.
 */
export function classifyPeerReplacements(
  previous: readonly CatalogEnvironment[],
  next: readonly CatalogEnvironment[],
  replacedIds: readonly string[]
): { retired: string[]; sameHost: SameHostPairingRotation[] } {
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
  return { retired, sameHost }
}
