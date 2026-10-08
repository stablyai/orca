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
      return (
        before !== undefined &&
        (before.pairingRevision ?? before.createdAt) !==
          (environment.pairingRevision ?? environment.createdAt)
      )
    })
    .map((environment) => environment.id)
}

// Re-pairs of a managed server whose host key was not yet known: the host key it had before.
const deferredHostKeyById = new Map<string, string | null>()

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

/**
 * Ids that now name a different machine, whose workspaces and tabs are retired. A managed server
 * re-pairs on every update and is the same machine while the host's key digest, which its pairing
 * handshake proves, is unchanged under the same SSH target registration. A registration alone is
 * no proof (a reinstall or a target that resolves elsewhere keeps it), so a re-pair whose key is
 * not known yet is decided later, once a catalog carries it, rather than purged on a guess.
 */
export function peerReplacedEnvironmentIds(
  previous: readonly CatalogEnvironment[],
  next: readonly CatalogEnvironment[],
  replacedIds: readonly string[]
): string[] {
  const nextById = new Map(next.map((environment) => [environment.id, environment]))
  const retired: string[] = []
  for (const id of replacedIds) {
    const before = previous.find((environment) => environment.id === id)
    const after = nextById.get(id)
    if (!sameRegistration(before, after)) {
      deferredHostKeyById.delete(id)
      retired.push(id)
      continue
    }
    const beforeKey = before?.hostKeyFingerprint ?? deferredHostKeyById.get(id) ?? null
    const afterKey = after?.hostKeyFingerprint
    if (beforeKey && afterKey) {
      deferredHostKeyById.delete(id)
      if (beforeKey !== afterKey) {
        retired.push(id)
      }
      continue
    }
    deferredHostKeyById.set(id, beforeKey)
  }
  for (const [id, beforeKey] of deferredHostKeyById) {
    const after = nextById.get(id)
    if (replacedIds.includes(id) || !after?.hostKeyFingerprint) {
      if (!after) {
        deferredHostKeyById.delete(id)
      }
      continue
    }
    deferredHostKeyById.delete(id)
    const before = previous.find((environment) => environment.id === id)
    if (!sameRegistration(before, after) || (beforeKey && beforeKey !== after.hostKeyFingerprint)) {
      retired.push(id)
    }
  }
  return retired
}
