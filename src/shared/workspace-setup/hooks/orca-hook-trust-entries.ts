import type {
  PersistedTrustedOrcaHookRepo,
  PersistedTrustedOrcaHooks
} from '../orca-yaml-hook-types'

export type OrcaHookTrustKind = Exclude<keyof PersistedTrustedOrcaHookRepo, 'all'>

const ORCA_HOOK_TRUST_KINDS = [
  'setup',
  'archive',
  'issueCommand',
  'vmRecipe'
] as const satisfies readonly OrcaHookTrustKind[]

export function isOrcaHookRepoIdOnSeveralHosts(
  repos: readonly { id: string }[],
  repoId: string
): boolean {
  return repos.filter((repo) => repo.id === repoId).length > 1
}

export function canUseRepoWideTrust(
  trust: PersistedTrustedOrcaHooks,
  repos: readonly { id: string }[],
  repoId: string
): boolean {
  // Why: with the id on two hosts, trusting one row's script could run the other's unseen.
  return Boolean(trust[repoId]?.all) && !isOrcaHookRepoIdOnSeveralHosts(repos, repoId)
}

/** Repo-wide trust; on a single host, an approval of any hook kind also trusts the repo. */
export function isOrcaHookRepoTrusted(
  trust: PersistedTrustedOrcaHooks,
  repos: readonly { id: string }[],
  repoId: string
): boolean {
  if (canUseRepoWideTrust(trust, repos, repoId)) {
    return true
  }
  return (
    !isOrcaHookRepoIdOnSeveralHosts(repos, repoId) &&
    ORCA_HOOK_TRUST_KINDS.some(
      (kind) => approvedOrcaHookContentHashes(trust, repoId, kind).length > 0
    )
  )
}

// Bounded, so a long-lived repo can't accumulate every script it ever had; large enough that
// switching between branches with different setup scripts rarely re-prompts.
export const MAX_APPROVED_ORCA_HOOK_HASHES = 20

/** Every content hash approved for this script, newest first. */
export function approvedOrcaHookContentHashes(
  trust: PersistedTrustedOrcaHooks,
  repoId: string,
  kind: OrcaHookTrustKind
): string[] {
  const entry: unknown = trust[repoId]?.[kind]
  if (!entry || typeof entry !== 'object') {
    return []
  }
  const latest = 'contentHash' in entry ? entry.contentHash : undefined
  const previous = 'previousContentHashes' in entry ? entry.previousContentHashes : undefined
  const hashes = [latest, ...(Array.isArray(previous) ? previous : [])].filter(
    (hash): hash is string => typeof hash === 'string' && hash.length > 0 && hash.length <= 128
  )
  return [...new Set(hashes)].slice(0, MAX_APPROVED_ORCA_HOOK_HASHES)
}

export function isOrcaHookContentApproved(
  trust: PersistedTrustedOrcaHooks,
  repoId: string,
  kind: OrcaHookTrustKind,
  contentHash: string
): boolean {
  return approvedOrcaHookContentHashes(trust, repoId, kind).includes(contentHash)
}

/** Whether a client may run this script without asking: the repo is trusted or this version was approved. */
export function isOrcaHookTrusted(
  trust: PersistedTrustedOrcaHooks,
  repos: readonly { id: string }[] | null,
  repoId: string,
  kind: OrcaHookTrustKind,
  contentHash: string
): boolean {
  return (
    (repos !== null && isOrcaHookRepoTrusted(trust, repos, repoId)) ||
    isOrcaHookContentApproved(trust, repoId, kind, contentHash)
  )
}

/** Returns `trust` itself when the approval is already the latest one recorded. */
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
  const previousContentHashes = approvedOrcaHookContentHashes(trust, repoId, kind)
    .filter((hash) => hash !== contentHash)
    .slice(0, MAX_APPROVED_ORCA_HOOK_HASHES - 1)
  return {
    ...trust,
    [repoId]: {
      ...existing,
      [kind]: {
        contentHash,
        approvedAt,
        ...(previousContentHashes.length > 0 ? { previousContentHashes } : {})
      }
    }
  }
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
