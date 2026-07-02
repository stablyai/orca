import { createCoalescedPollRunner, type CoalescedPollRunner } from '@/lib/coalesced-poll-runner'

export type ReposChangedRefetchActions = {
  fetchRepos: () => Promise<void>
  fetchProjectGroups: () => Promise<void>
  fetchFolderWorkspaces: () => Promise<void>
  fetchReposForAllHosts: () => Promise<void>
  fetchProjectGroupsForAllHosts: () => Promise<void>
  fetchFolderWorkspacesForAllHosts: () => Promise<void>
}

export type ReposChangedRefetchOptions = {
  getActions: () => ReposChangedRefetchActions
  isRuntimeEnvironmentActive: () => boolean
}

/**
 * Why: main broadcasts `repos:changed` once per persisted mutation, so deleting
 * a project group that also removes N contained projects emits N+1 events in a
 * burst. Firing an independent, unsequenced refetch per event let an early
 * refetch — one that read persisted state before the removals landed — resolve
 * last and overwrite the store, resurfacing just-removed projects as stale
 * sidebar rows until restart. Coalescing the refetches through a serial runner
 * guarantees they never overlap and that a trailing run always executes after
 * the final event, so the store settles on the final persisted state.
 */
export function createReposChangedRefetchRunner(
  options: ReposChangedRefetchOptions
): CoalescedPollRunner {
  return createCoalescedPollRunner(async () => {
    const actions = options.getActions()
    if (options.isRuntimeEnvironmentActive()) {
      // Why: the all-host sidebar still shows local repos while a runtime is
      // focused, so refresh every host's slice without dropping the
      // runtime-owned slices already shown.
      await actions.fetchReposForAllHosts()
      await actions.fetchProjectGroupsForAllHosts()
      await actions.fetchFolderWorkspacesForAllHosts()
      return
    }
    await Promise.all([
      actions.fetchProjectGroups(),
      actions.fetchFolderWorkspaces(),
      actions.fetchRepos()
    ])
  })
}
