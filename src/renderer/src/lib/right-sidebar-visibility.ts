import type { AppState } from '@/store/types'
import { getIndexedRepoMap, getIndexedWorktreeById } from '@/store/worktree-repo-index'
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

export function isRightSidebarRevealed(
  state: Pick<AppState, 'rightSidebarOpen' | 'rightSidebarPeek'>
): boolean {
  return state.rightSidebarOpen || state.rightSidebarPeek
}

export function rightSidebarShowsPullRequestData(
  state: Pick<
    AppState,
    | 'activeView'
    | 'activeWorktreeId'
    | 'repos'
    | 'rightSidebarOpen'
    | 'rightSidebarPeek'
    | 'rightSidebarTab'
    | 'worktreesByRepo'
  >
): boolean {
  if (
    !canShowRightSidebarForView(state.activeView) ||
    !isRightSidebarRevealed(state) ||
    (state.rightSidebarTab !== 'checks' && state.rightSidebarTab !== 'source-control')
  ) {
    return false
  }

  // Why: this helper runs inside an always-mounted Zustand selector. Reuse the
  // slice-identity indexes so terminal/status writes do not rescan every worktree.
  const activeWorktree = state.activeWorktreeId
    ? getIndexedWorktreeById(state.worktreesByRepo, state.activeWorktreeId)
    : undefined
  const activeRepo = activeWorktree
    ? getIndexedRepoMap(state.repos).get(activeWorktree.repoId)
    : null
  if (!activeRepo || isFolderRepo(activeRepo)) {
    return false
  }

  return true
}
