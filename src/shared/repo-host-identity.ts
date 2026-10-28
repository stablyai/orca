import { getRepoExecutionHostId, type ExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'

declare const hostScopedRepoKeyBrand: unique symbol

// Why: for new code only; existing raw-id stores stay as they are (D7).
export type HostScopedRepoKey = string & { readonly [hostScopedRepoKeyBrand]: true }

/** A repo write's target: the row's own identity fields, so its host can't be dropped or guessed. */
export type RepoHostTarget = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export function getRepoHostIdentityForParts(repoId: string, hostId: string): HostScopedRepoKey {
  // Why: host ids and repo ids can contain punctuation; NUL keeps the composite
  // key collision-free without escaping user/provider-owned strings.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the only constructor of the brand; the bytes are the unbranded composite, frozen by golden tests (D25).
  return `${hostId}\0${repoId}` as HostScopedRepoKey
}

/** One host's registration of a repo; the same repo id may be registered on several hosts. */
export function getRepoHostIdentity(repo: RepoHostTarget): HostScopedRepoKey {
  return getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
}

/** The hosts registering `repoId`; two or more means same-id twins on different hosts. */
export function getRepoRegistrationHostIds(
  repos: readonly RepoHostTarget[],
  repoId: string
): Set<ExecutionHostId> {
  return new Set(repos.filter((repo) => repo.id === repoId).map(getRepoExecutionHostId))
}
