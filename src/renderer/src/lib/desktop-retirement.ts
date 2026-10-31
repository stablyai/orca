import { getActiveExecutionHostIdForWorktree } from './unified-tab-host-ownership'
import type { AppState } from '@/store/types'
import {
  captureDesktopNavigation,
  canPresentDesktopNavigation,
  hasNewerDesktopSelection,
  isExperimentalDesktopNavigation
} from './desktop-navigation-request'
import { desktopWorkspaceContextView, effectiveWorkspaceView } from './renderer-view'

/** Retirement observes the original target; removal and acknowledgement never need a page claim. */
export function captureDesktopRetirement(state: AppState, worktreeId: string, groupId: string) {
  const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === groupId)
  const isForeground =
    effectiveWorkspaceView(state) === 'terminal' && state.activeWorktreeId === worktreeId
  const active =
    state.activeWorktreeId && (state.settings?.experimentalThreads === true || isForeground)
      ? state.getActiveTab(state.activeWorktreeId)
      : null
  return {
    navigation: captureDesktopNavigation(state),
    experimentalOrigin: isExperimentalDesktopNavigation(state, false, active),
    hostId: state.activeWorkspaceExecutionHostId,
    worktreeId,
    groupId,
    context: desktopWorkspaceContextView(state),
    selectedTabId: group?.activeTabId ?? null,
    foregroundTabId: isForeground ? (active?.id ?? null) : null
  }
}
export type DesktopRetirement = ReturnType<typeof captureDesktopRetirement>

export function protectsEmptyWorkbench(state: AppState, retirement?: DesktopRetirement): boolean {
  const context = desktopWorkspaceContextView(state)
  const rawContext = desktopWorkspaceContextView({
    activeView: state.activeView,
    previousViewBeforeSettings: state.previousViewBeforeSettings,
    previousViewBeforeTasks: state.previousViewBeforeTasks,
    settings: { experimentalThreads: true }
  })
  return (
    context === 'empty-workbench' ||
    (rawContext === 'empty-workbench' &&
      !!retirement &&
      (retirement.context === 'empty-workbench' ||
        captureDesktopNavigation(state).experimentalGeneration !==
          retirement.navigation.experimentalGeneration))
  )
}

export function canRepairRetiredSelection(state: AppState, retirement: DesktopRetirement): boolean {
  if (
    state.activeWorktreeId === retirement.worktreeId &&
    state.activeGroupIdByWorktree[retirement.worktreeId] === retirement.groupId &&
    protectsEmptyWorkbench(state, retirement)
  ) {
    const selected = state.groupsByWorktree[retirement.worktreeId]?.find(
      (group) => group.id === retirement.groupId
    )?.activeTabId
    const tab = state.unifiedTabsByWorktree[retirement.worktreeId]?.find(
      (entry) => entry.id === selected
    )
    const host = getActiveExecutionHostIdForWorktree(state, retirement.worktreeId)
    if (!tab?.executionHostId || tab.executionHostId === host) {
      return false
    }
  }
  return !hasNewerDesktopSelection(
    state,
    retirement.navigation,
    retirement.worktreeId,
    retirement.groupId,
    retirement.experimentalOrigin
  )
}

export function canReplaceRetiredForeground(
  state: AppState,
  retirement: DesktopRetirement,
  retiredTabId: string
): boolean {
  return (
    retirement.foregroundTabId === retiredTabId &&
    canPresentDesktopNavigation(retirement.navigation) &&
    effectiveWorkspaceView(state) === 'terminal' &&
    state.activeWorktreeId === retirement.worktreeId &&
    state.activeGroupIdByWorktree[retirement.worktreeId] === retirement.groupId &&
    state.activeWorkspaceExecutionHostId === retirement.hostId
  )
}
