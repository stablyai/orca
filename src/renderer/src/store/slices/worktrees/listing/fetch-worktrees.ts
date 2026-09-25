import type {
  DirectSshWorktreeFetchOptions,
  WorktreeFetchOptions,
  WorktreeSlice
} from '../../worktree-helpers'
import type { HostQualifiedDetectedWorktreeResult } from '../../../../../../shared/detected-worktree-provider-contract'
import { isStaleWorktreeCatalogPublication } from './worktree-catalog-version-state'
import type { WorktreeSliceGet, WorktreeSliceSet } from './worktree-slice-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { findRepoForHost } from '../../repo-host-identity'
import { getCurrentDirectSshAuthority } from './direct-ssh-authority'
import { listDetectedWorktreesForRepoCoalesced } from './detected-worktree-refresh'
import { staleDetectedWorktreeProviderResult } from './detected-worktree-refresh-admission'
import {
  getKnownWorktreeIdsForPurge,
  getProjectHostSetupForRepoHost,
  repoHostId
} from './worktree-host-ownership'
import { fetchKnownSshWorktreesForRepo } from './known-ssh-worktree-fetch'
import { mergeFetchedWorktrees } from './fetched-worktree-merge'
import { notifyRuntimeScopeForbiddenIfNeeded } from './runtime-scope-forbidden-toast'
import { refreshRemoteWorktreeLineageBestEffort } from '../metadata/worktree-lineage-refresh'
import { settingsForRepoOwner } from './worktree-owner-settings'

export function createFetchWorktrees(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['fetchWorktrees'] {
  // Why declared overloads: the slice type is an overload pair, and a declaration carries it
  // without asserting the implementation into shape.
  function fetchWorktrees(
    repoId: string,
    options: DirectSshWorktreeFetchOptions
  ): Promise<HostQualifiedDetectedWorktreeResult>
  function fetchWorktrees(repoId: string, options?: WorktreeFetchOptions): Promise<boolean>
  async function fetchWorktrees(
    repoId: string,
    options?: WorktreeFetchOptions | DirectSshWorktreeFetchOptions
  ): Promise<boolean | HostQualifiedDetectedWorktreeResult> {
    return fetchWorktreesAttempt(repoId, options, true)
  }
  async function fetchWorktreesAttempt(
    repoId: string,
    options: WorktreeFetchOptions | DirectSshWorktreeFetchOptions | undefined,
    relistIfStale: boolean
  ): Promise<boolean | HostQualifiedDetectedWorktreeResult> {
    const directCallerAuthority =
      options && 'directSshAuthority' in options ? options.directSshAuthority : undefined
    try {
      const ownerState = get()
      const requestStartedWorktrees = ownerState.worktreesByRepo[repoId]
      const repoOwners = ownerState.repos.filter((repo) => repo.id === repoId)
      const ownerWasMissingAtStart = repoOwners.length === 0
      const hasLocalOwner = repoOwners.some(
        (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
      // Why: a local event may share its repo id with the focused runtime; prefer
      // the local owner without redirecting runtime/SSH-only repos.
      const useLocalOwner =
        options?.forceLocalOwner === true && (hasLocalOwner || repoOwners.length === 0)
      const hostId = useLocalOwner
        ? LOCAL_EXECUTION_HOST_ID
        : repoHostId(ownerState, repoId, options?.executionHostId)
      const setup = getProjectHostSetupForRepoHost(ownerState, repoId, hostId)
      const repoOwner = findRepoForHost(ownerState.repos, repoId, {
        hostId,
        settings: ownerState.settings
      })
      const ownerSettings = settingsForRepoOwner(
        ownerState,
        repoId,
        hostId,
        ownerWasMissingAtStart && (useLocalOwner || options?.executionHostId !== undefined)
      )
      const settings =
        useLocalOwner && ownerSettings?.activeRuntimeEnvironmentId
          ? { ...ownerSettings, activeRuntimeEnvironmentId: null }
          : ownerSettings
      const parsedHost = parseExecutionHostId(hostId)
      const directSshAuthority =
        parsedHost?.kind === 'ssh'
          ? (directCallerAuthority ?? getCurrentDirectSshAuthority(ownerState, hostId) ?? undefined)
          : undefined
      if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
        // Why: requireAuthoritative callers asked for authoritative-or-nothing, so writing non-authoritative
        // rows as a side effect before returning false would silently weaken that contract.
        if (!options?.requireAuthoritative) {
          await fetchKnownSshWorktreesForRepo(set, repoId, parsedHost.id)
        }
        return false
      }
      const refresh = await listDetectedWorktreesForRepoCoalesced(settings, repoId, {
        executionHostId: hostId,
        requireAuthoritative: options?.requireAuthoritative,
        directSshAuthority,
        connectionId: repoOwner?.connectionId,
        knownWorktreeIds: getKnownWorktreeIdsForPurge(ownerState, repoId, hostId),
        isStaleCatalogPublication: (result) =>
          isStaleWorktreeCatalogPublication(get(), repoId, hostId, result.catalogVersion)
      })
      if (refresh.status !== 'admitted') {
        return directCallerAuthority ? refresh.providerResult : false
      }
      if (options?.requireAuthoritative && !refresh.result.authoritative) {
        return directCallerAuthority ? (refresh.providerResult ?? false) : false
      }
      const outcome = mergeFetchedWorktrees(set, {
        repoId,
        hostId,
        ownerWasMissingAtStart,
        missingDirectSshOwnerReposSnapshot:
          ownerWasMissingAtStart && options?.executionHostId === hostId
            ? ownerState.repos
            : undefined,
        requestStartedWorktrees,
        setup,
        refresh
      })
      switch (outcome) {
        case 'applied':
          break
        case 'superseded':
          // Why current for direct callers: a newer catalog is already applied; 'stale' means a moved
          // connection. Others relist once: a caller that joined a listing already in flight (a
          // change event's refresh) may get only that older answer, and nothing else would follow
          // it. One new listing scans at or past the applied version, so it is admitted.
          if (directCallerAuthority) {
            return refresh.providerResult ?? false
          }
          return relistIfStale ? fetchWorktreesAttempt(repoId, options, false) : false
        case 'not-current':
          return directCallerAuthority
            ? (staleDetectedWorktreeProviderResult(refresh) ?? false)
            : false
      }
      // Direct SSH lineage requires its own qualified authority result.
      // Bulk runtime callers apply one final host-wide snapshot after all repo merges.
      if (!directSshAuthority && !options?.suppressRemoteLineageRefresh) {
        await refreshRemoteWorktreeLineageBestEffort(settings, set, get)
      }
      return directCallerAuthority ? refresh.providerResult! : refresh.result.authoritative
    } catch (err) {
      if (notifyRuntimeScopeForbiddenIfNeeded(err)) {
        return false
      }
      console.error(`Failed to fetch worktrees for repo ${repoId}:`, err)
      return false
    }
  }
  return fetchWorktrees
}
