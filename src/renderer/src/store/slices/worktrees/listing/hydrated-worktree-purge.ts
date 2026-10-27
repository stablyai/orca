import { runAsAutomaticDeselection } from '@/store/active-worktree-deselection-intent'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces
} from '../../../workspace-record-selectors'
import { worktreeListingRefusal } from './detected-worktree-refresh-admission'
import { worktreeCatalogVersionKey } from './worktree-catalog-version-state'
import type { WorktreeRefreshResult } from './worktree-refresh-result'
import type { WorktreeSliceGet, WorktreeSliceSet } from './worktree-slice-types'

export function purgeHydratedWorktrees(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet,
  results: readonly WorktreeRefreshResult[]
): void {
  const state = get()
  if (
    state.hasHydratedWorktreePurge ||
    state.workspaceSessionReady === false ||
    state.hydrationSucceeded === false ||
    results.length === 0
  ) {
    return
  }
  const coveredOwners = new Set<string>()
  let hasAnyDetectedWorktree = false
  for (const { repoId, hostId, refresh } of results) {
    if (
      !refresh?.result.authoritative ||
      worktreeListingRefusal(state, refresh, repoId, hostId, false) !== null
    ) {
      return
    }
    coveredOwners.add(worktreeCatalogVersionKey(repoId, hostId))
    hasAnyDetectedWorktree ||= refresh.result.worktrees.length > 0
  }
  if (
    !hasAnyDetectedWorktree ||
    state.repos.some(
      (repo) => !coveredOwners.has(worktreeCatalogVersionKey(repo.id, getRepoExecutionHostId(repo)))
    )
  ) {
    return
  }
  for (const [key, hostId] of Object.entries(
    state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {}
  )) {
    const scope = parseWorkspaceKey(key)
    if (scope?.type === 'folder') {
      continue
    }
    const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : key
    if (
      !coveredOwners.has(worktreeCatalogVersionKey(getRepoIdFromWorktreeId(worktreeId), hostId))
    ) {
      return
    }
  }
  const validIds = new Set<string>([FLOATING_TERMINAL_WORKTREE_ID])
  for (const workspace of selectFolderWorkspaces(state) ?? []) {
    validIds.add(folderWorkspaceKey(workspace.id))
  }
  for (const key of Object.keys(state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {})) {
    if (parseWorkspaceKey(key)?.type === 'folder') {
      validIds.add(key)
    }
  }
  for (const result of Object.values(selectDetectedWorktreesByRepo(state))) {
    if (!result.authoritative) {
      continue
    }
    for (const worktree of result.worktrees) {
      validIds.add(worktree.id)
    }
  }
  const stale = Object.keys(state.tabsByWorktree).filter((id) => !validIds.has(id))
  if (stale.length > 0) {
    console.warn(
      `[worktree-purge] hydration-time purge removing stale state for ${stale.length} worktree(s):`,
      stale
    )
    runAsAutomaticDeselection(() => get().purgeWorktreeTerminalState(stale))
  }
  set({ hasHydratedWorktreePurge: true })
}
