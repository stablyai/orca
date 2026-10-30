import type {
  PersistedTrustedOrcaHookRepo,
  PersistedTrustedOrcaHooks
} from './orca-yaml-hook-types'

export type OrcaHookTrustKind = Exclude<keyof PersistedTrustedOrcaHookRepo, 'all'>

export function canUseRepoWideTrust(
  trust: PersistedTrustedOrcaHooks,
  repos: readonly { id: string }[],
  repoId: string
): boolean {
  // Why: with the id on two hosts, trusting one row's script could run the other's unseen.
  return Boolean(trust[repoId]?.all) && repos.filter((repo) => repo.id === repoId).length < 2
}

/** Returns `trust` itself when the approval is already recorded. */
export function withOrcaHookScriptConfirmed(
  trust: PersistedTrustedOrcaHooks,
  repoId: string,
  kind: OrcaHookTrustKind,
  contentHash: string,
  approvedAt: number = Date.now()
): PersistedTrustedOrcaHooks {
  const existing = trust[repoId]
  if (existing?.[kind]?.contentHash === contentHash) {
    return trust
  }
  return { ...trust, [repoId]: { ...existing, [kind]: { contentHash, approvedAt } } }
}

/** Returns `trust` itself when the repo is already always-trusted. */
export function withOrcaHookRepoAlwaysTrusted(
  trust: PersistedTrustedOrcaHooks,
  repoId: string,
  approvedAt: number = Date.now()
): PersistedTrustedOrcaHooks {
  const existing = trust[repoId]
  if (existing?.all) {
    return trust
  }
  return { ...trust, [repoId]: { ...existing, all: { approvedAt } } }
}
