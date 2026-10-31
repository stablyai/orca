import { workspaceView, type RendererView } from './renderer-view'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import {
  desktopThreadIds,
  visibleGroupActiveTabId
} from '@/components/threads/desktop-tab-projection'
import type { AppState } from '@/store/types'

export type DesktopNavigationRequest = {
  readonly originView: RendererView
  readonly id: number
  readonly experimental: boolean
  readonly experimentalGeneration: number
}
let sequence = 0
let experimentalGeneration = 0
let latest = 0

/** Ordinary completions keep their established behavior until an experimental interaction supersedes them. */
export function beginDesktopNavigation(
  state: AppState,
  destinationIsExperimental = false
): DesktopNavigationRequest {
  latest = ++sequence
  const selected = state.activeWorktreeId ? state.getActiveTab?.(state.activeWorktreeId) : null
  const experimental =
    state.settings?.experimentalThreads === true &&
    (destinationIsExperimental ||
      state.activeView === 'thread-draft' ||
      state.activeView === 'empty-workbench' ||
      (!!selected && desktopThreadIds(state, selected.worktreeId).has(selected.id)))
  if (experimental) {
    experimentalGeneration++
  }
  return { originView: state.activeView, id: latest, experimental, experimentalGeneration }
}

export function canPresentDesktopNavigation(request: DesktopNavigationRequest): boolean {
  return request.experimental
    ? request.id === latest
    : request.experimentalGeneration === experimentalGeneration
}

/** Only an interaction's accepted destination may replace the foreground, including canonical selection. */
export function commitDesktopNavigation(
  request: DesktopNavigationRequest,
  commit: () => void
): boolean {
  if (!canPresentDesktopNavigation(request)) {
    return false
  }
  commit()
  return true
}

/** A modal masks the destination; an ordinary completion behind another section does not open it. */
export function presentDesktopWorkspace(
  state: AppState,
  request: DesktopNavigationRequest,
  view: 'terminal' | 'thread-draft' | 'empty-workbench' = 'terminal'
): void {
  if (state.activeView === 'settings' && request.originView !== 'settings') {
    state.setActiveView(view, request.originView)
  } else if (request.id === latest || workspaceView(state.activeView) === 'terminal') {
    if (state.activeView !== view) {
      state.setActiveView(view)
    }
  }
}

export function navigateDesktopTab(
  state: AppState,
  tabId: string,
  options?: {
    worktreeId?: string
    preservePreview?: boolean
    request?: DesktopNavigationRequest
  }
): boolean {
  const tab = state.getTab(tabId)
  if (options?.worktreeId && tab?.worktreeId !== options.worktreeId) {
    return false
  }
  if (!tab) {
    return false
  }
  if (isFloatingWorkspaceId(tab.worktreeId)) {
    state.activateTab(tabId, options)
    return true
  }
  const request =
    options?.request ??
    beginDesktopNavigation(state, desktopThreadIds(state, tab.worktreeId).has(tab.id))
  return commitDesktopNavigation(request, () => {
    if (options) {
      const { request: _request, ...activation } = options
      if (activation.worktreeId !== undefined || activation.preservePreview !== undefined) {
        state.activateTab(tabId, activation)
      } else {
        state.activateTab(tabId)
      }
    } else {
      state.activateTab(tabId)
    }
    presentDesktopWorkspace(state, request)
    if (
      state.activeWorktreeId !== tab.worktreeId ||
      (tab.executionHostId && state.activeWorkspaceExecutionHostId !== tab.executionHostId)
    ) {
      state.setActiveWorktree(tab.worktreeId, tab.executionHostId)
    }
  })
}

/** Pane focus is an interaction; group bookkeeping itself is not. */
export function navigateDesktopGroup(
  state: AppState,
  worktreeId: string,
  groupId: string
): boolean {
  const group = state.groupsByWorktree[worktreeId]?.find((g) => g.id === groupId)
  if (!group) {
    return false
  }
  if (isFloatingWorkspaceId(worktreeId)) {
    state.focusGroup(worktreeId, groupId)
    return true
  }
  if (group.activeTabId) {
    return navigateDesktopTab(state, group.activeTabId, { worktreeId })
  }
  const request = beginDesktopNavigation(state)
  return commitDesktopNavigation(request, () => {
    presentDesktopWorkspace(state, request, 'empty-workbench')
    if (state.activeWorktreeId !== worktreeId) {
      state.setActiveWorktree(worktreeId)
    }
    state.focusGroup(worktreeId, groupId)
  })
}

/** The accepted workspace open shows visible MRU or an explicit empty page, keeping raw inventory. */
export function openDesktopWorkbench(
  state: AppState,
  worktreeId: string,
  request = beginDesktopNavigation(state)
): void {
  commitDesktopNavigation(request, () => {
    const group = state.groupsByWorktree[worktreeId]?.find(
      (g) => g.id === state.activeGroupIdByWorktree[worktreeId]
    )
    const hidden = desktopThreadIds(state, worktreeId)
    const next = group ? visibleGroupActiveTabId(group, hidden) : null
    presentDesktopWorkspace(
      state,
      request,
      group?.activeTabId && hidden.has(group.activeTabId) && !next ? 'empty-workbench' : 'terminal'
    )
    if (next && group && next !== group.activeTabId) {
      state.activateTab(next, { worktreeId })
      state.focusGroup(worktreeId, group.id)
    }
  })
}
