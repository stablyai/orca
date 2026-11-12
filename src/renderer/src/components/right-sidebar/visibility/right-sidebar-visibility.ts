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
  'mobile'
])

export function canShowRightSidebarForView(activeView: ActiveView): boolean {
  return !RIGHT_SIDEBAR_SUPPRESSED_VIEWS.has(activeView)
}

/**
 * Home's first-run welcome (no project yet, nothing selected) has nothing to browse, so the right
 * sidebar stays out of it; it returns as before once a project exists.
 */
export function isFirstRunWelcomeShown(layout: {
  activeView: ActiveView
  hasActiveWorktree: boolean
  creationLayoutActive: boolean
  projectCount: number
}): boolean {
  return (
    layout.activeView === 'terminal' &&
    !layout.hasActiveWorktree &&
    !layout.creationLayoutActive &&
    layout.projectCount === 0
  )
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
