import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'

type ExistingTasksTab = {
  id: string
  groupId: string
  contentType: string
}

export function getTasksTabForWorktree(worktreeId: string): ExistingTasksTab | null {
  return (
    (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'tasks'
    ) ?? null
  )
}

/** Tasks are provider work items fetched per repo — the tab needs a
 *  git-backed repo. Pass `state` from zustand selectors so the check reads
 *  the subscribed snapshot (stays reactive) instead of `getState()`. */
export function worktreeSupportsTasksTab(
  worktreeId: string,
  state: Pick<AppState, 'getKnownWorktreeById' | 'repos'> = useAppStore.getState()
): boolean {
  const repoId =
    state.getKnownWorktreeById?.(worktreeId)?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = (state.repos ?? []).find((candidate) => candidate.id === repoId)
  return Boolean(repo && isGitRepoKind(repo))
}

/** One tasks tab per worktree; focuses the existing tab instead of creating duplicates. */
export function ensureTasksTab(
  worktreeId: string,
  options?: { targetGroupId?: string }
): string | null {
  const store = useAppStore.getState()
  if (!worktreeSupportsTasksTab(worktreeId)) {
    return null
  }
  const sourceGroupId =
    options?.targetGroupId ??
    store.activeGroupIdByWorktree[worktreeId] ??
    store.groupsByWorktree[worktreeId]?.[0]?.id
  if (!sourceGroupId) {
    return null
  }

  const existing = getTasksTabForWorktree(worktreeId)
  if (existing) {
    if (store.activeWorktreeId === worktreeId) {
      store.activateTab(existing.id)
      store.focusGroup(worktreeId, existing.groupId)
      store.setActiveTabType('tasks')
    }
    return existing.id
  }

  const tab = store.createUnifiedTab(worktreeId, 'tasks', {
    label: translate('auto.lib.ensure.tasks.tab.7889c1175d', 'Tasks'),
    targetGroupId: sourceGroupId,
    activate: true
  })
  store.activateTab(tab.id)
  store.setActiveTabType('tasks')
  store.focusGroup(worktreeId, tab.groupId)
  return tab.id
}
