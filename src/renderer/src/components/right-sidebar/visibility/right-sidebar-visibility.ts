import type { AppState } from '@/store/types'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

type ActiveView = AppState['activeView']

const RIGHT_SIDEBAR_SUPPRESSED_VIEWS = new Set<ActiveView>([
  'settings',
  'tasks',
  'activity',
  'automations',
  'space',
  'skills',
  'artifacts',
  'mobile',
  'community'
])

export function canShowRightSidebarForView(activeView: ActiveView): boolean {
  return !RIGHT_SIDEBAR_SUPPRESSED_VIEWS.has(activeView)
}

/** Workspace and creation surfaces have no titlebar strip, so the closed sidebar needs its own toggle there. */
export function showsFloatingRightSidebarToggle(layout: {
  activeView: ActiveView
  workspaceChromeActive: boolean
  creationLayoutActive: boolean
  rightSidebarOpen: boolean
}): boolean {
  return (
    (layout.workspaceChromeActive || layout.creationLayoutActive) &&
    !layout.rightSidebarOpen &&
    canShowRightSidebarForView(layout.activeView)
  )
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

  const activeWorktree = state.activeWorktreeId
    ? getIndexedWorktreeMap(selectWorktreesByRepo(state)).get(state.activeWorktreeId)
    : undefined
  const activeRepo = activeWorktree
    ? getIndexedRepoMap(state.repos).get(activeWorktree.repoId)
    : null
  if (!activeRepo || isFolderRepo(activeRepo)) {
    return false
  }

  return true
}
