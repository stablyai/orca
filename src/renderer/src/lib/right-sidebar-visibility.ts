import type { AppState } from '@/store/types'
import { isFolderRepo } from '../../../shared/repo-kind'

type ActiveView = AppState['activeView']

const RIGHT_SIDEBAR_SUPPRESSED_VIEWS = new Set<ActiveView>([
  'settings',
  'tasks',
  'activity',
  'automations',
  'space',
  'skills',
  'mobile'
])

export function canShowRightSidebarForView(activeView: ActiveView): boolean {
  return !RIGHT_SIDEBAR_SUPPRESSED_VIEWS.has(activeView)
}

export function rightSidebarShowsPullRequestData(
  state: Pick<
    AppState,
    | 'activeView'
    | 'activeWorktreeId'
    | 'repos'
    | 'rightSidebarOpen'
    | 'rightSidebarTab'
    | 'worktreesByRepo'
  >
): boolean {
  if (
    !canShowRightSidebarForView(state.activeView) ||
    !state.rightSidebarOpen ||
    (state.rightSidebarTab !== 'checks' && state.rightSidebarTab !== 'source-control')
  ) {
    return false
  }

  const activeWorktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((worktree) => worktree.id === state.activeWorktreeId)
  const activeRepo = activeWorktree
    ? state.repos.find((repo) => repo.id === activeWorktree.repoId)
    : null
  if (!activeRepo || isFolderRepo(activeRepo)) {
    return false
  }

  return true
}
