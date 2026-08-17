import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from './worktree-slice-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { getCurrentDirectSshAuthority } from './direct-ssh-authority'
import { listDetectedWorktreesForRepoCoalesced } from './detected-worktree-refresh'
import {
  getKnownWorktreeIdsForPurge,
  getProjectHostSetupForRepoHost
} from './worktree-host-ownership'
import { fetchKnownSshWorktreesForRepo } from './known-ssh-worktree-fetch'
import { mergeFetchedWorktrees } from './fetched-worktree-merge'
import { notifyRuntimeScopeForbiddenIfNeeded } from './runtime-scope-forbidden-toast'
import { mapReposForWorktreeRefresh } from './worktree-refresh-pool'
import { settingsForKnownRepoOwner } from './worktree-owner-settings'

export function createFetchAllWorktrees(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['fetchAllWorktrees'] {
  return async (options) => {
    const repos = options?.visibilityOwnerHostId
      ? get().repos.filter((repo) => {
          const repoHost = parseExecutionHostId(getRepoExecutionHostId(repo))
          const ownerHost = parseExecutionHostId(options.visibilityOwnerHostId)
          return ownerHost?.kind === 'runtime'
            ? repoHost?.kind === 'runtime' && repoHost.environmentId === ownerHost.environmentId
            : repoHost?.kind !== 'runtime'
        })
      : get().repos

    // Why: after the one-shot hydration purge, later calls only refresh cached lists — no IPC double-probe for the per-repo success signal.
    if (get().hasHydratedWorktreePurge || options?.visibilityOwnerHostId) {
      await mapReposForWorktreeRefresh(repos, async (r) => {
        try {
          const requestStartedState = get()
          const requestStartedWorktrees = requestStartedState.worktreesByRepo[r.id]
          const hostId = getRepoExecutionHostId(r)
          const setup = getProjectHostSetupForRepoHost(requestStartedState, r.id, hostId)
          const settings = settingsForKnownRepoOwner(requestStartedState.settings, r)
          const parsedHost = parseExecutionHostId(hostId)
          const directSshAuthority =
            parsedHost?.kind === 'ssh'
              ? (getCurrentDirectSshAuthority(requestStartedState, hostId) ?? undefined)
              : undefined
          if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
            await fetchKnownSshWorktreesForRepo(set, r.id, parsedHost.id)
            return
          }
          const refresh = await listDetectedWorktreesForRepoCoalesced(settings, r.id, {
            executionHostId: hostId,
            reuseRecentCompatibilityFailure: true,
            directSshAuthority,
            connectionId: r.connectionId,
            knownWorktreeIds: getKnownWorktreeIdsForPurge(requestStartedState, r.id, hostId)
          })
          if (refresh.status !== 'admitted') {
            return
          }
          mergeFetchedWorktrees(set, {
            repoId: r.id,
            hostId,
            ownerWasMissingAtStart: false,
            requestStartedWorktrees,
            setup,
            refresh
          })
        } catch (err) {
          if (notifyRuntimeScopeForbiddenIfNeeded(err)) {
            return
          }
          console.error(`Failed to fetch worktrees for repo ${r.id}:`, err)
        }
      })
      return
    }

    // Why: a pre-fix upgrade can persist tabsByWorktree entries for worktrees deleted last session; without this hydration purge they leave zombie PTYs misclassified as "bound" (design §2c) until a second restart.
    // Safety gate: fetchWorktrees swallows IPC errors and short-circuits on empty-replace, so probe the IPC directly for the per-repo success signal instead of re-listing.
    const results = await mapReposForWorktreeRefresh(
      repos,
      async (
        r
      ): Promise<
        | { repoId: string; ok: boolean; detected: DetectedWorktreeListResult }
        | { repoId: string; ok: false }
      > => {
        try {
          const requestStartedState = get()
          const requestStartedWorktrees = requestStartedState.worktreesByRepo[r.id]
          const hostId = getRepoExecutionHostId(r)
          const setup = getProjectHostSetupForRepoHost(requestStartedState, r.id, hostId)
          const parsedHost = parseExecutionHostId(hostId)
          const directSshAuthority =
            parsedHost?.kind === 'ssh'
              ? (getCurrentDirectSshAuthority(requestStartedState, hostId) ?? undefined)
              : undefined
          if (parsedHost?.kind === 'ssh' && !directSshAuthority) {
            await fetchKnownSshWorktreesForRepo(set, r.id, parsedHost.id)
            return { repoId: r.id, ok: false as const }
          }
          const refresh = await listDetectedWorktreesForRepoCoalesced(
            settingsForKnownRepoOwner(requestStartedState.settings, r),
            r.id,
            {
              executionHostId: hostId,
              reuseRecentCompatibilityFailure: true,
              directSshAuthority,
              connectionId: r.connectionId,
              knownWorktreeIds: getKnownWorktreeIdsForPurge(requestStartedState, r.id, hostId)
            }
          )
          if (refresh.status !== 'admitted') {
            return { repoId: r.id, ok: false as const }
          }
          const admitted = mergeFetchedWorktrees(set, {
            repoId: r.id,
            hostId,
            ownerWasMissingAtStart: false,
            requestStartedWorktrees,
            setup,
            refresh,
            purgeRemovedWorktrees: false
          })
          if (!admitted) {
            return { repoId: r.id, ok: false as const }
          }
          return {
            repoId: r.id,
            ok: refresh.result.authoritative,
            detected: refresh.result
          }
        } catch (err) {
          if (!notifyRuntimeScopeForbiddenIfNeeded(err)) {
            console.error(`Failed to fetch worktrees for repo ${r.id}:`, err)
          }
          return { repoId: r.id, ok: false as const }
        }
      }
    )

    const hasAnyDetectedWorktree = results.some(
      (result) => 'detected' in result && result.ok && result.detected.worktrees.length > 0
    )
    const allSucceeded = results.length > 0 && results.every((r) => r.ok) && hasAnyDetectedWorktree
    if (!allSucceeded) {
      // Defer; try again on the next fetchAllWorktrees call.
      return
    }
    if (
      options?.hydrationPurge === 'defer' ||
      get().workspaceSessionReady === false ||
      get().hydrationSucceeded === false
    ) {
      // Why: startup refreshes local repos first; defer the one-shot purge to the later all-host refresh, once remote worktree ids are known.
      return
    }
    const validIds = new Set<string>()
    // Why: floating is persisted renderer state, not a repo worktree an authoritative scan returns.
    validIds.add(FLOATING_TERMINAL_WORKTREE_ID)
    // Why: folder workspaces persist tabs under `folder:<id>` keys that authoritative repo scans never return.
    for (const workspace of get().folderWorkspaces ?? []) {
      validIds.add(folderWorkspaceKey(workspace.id))
    }
    for (const key of Object.keys(get().restoredRuntimeHostIdByWorkspaceSessionKey ?? {})) {
      if (parseWorkspaceKey(key)?.type === 'folder') {
        validIds.add(key)
      }
    }
    for (const result of Object.values(get().detectedWorktreesByRepo)) {
      if (!result.authoritative) {
        continue
      }
      for (const w of result.worktrees) {
        validIds.add(w.id)
      }
    }
    const stale = Object.keys(get().tabsByWorktree).filter((id) => !validIds.has(id))
    if (stale.length > 0) {
      console.warn(
        `[worktree-purge] hydration-time purge removing stale state for ${stale.length} worktree(s):`,
        stale
      )
      get().purgeWorktreeTerminalState(stale)
    }
    set({ hasHydratedWorktreePurge: true })
  }
}
