import { useMemo } from 'react'
import { useAppStore } from '../../store'

/** Zustand actions never change after store creation; bind once via getState to avoid per-action listeners and selectors on every retained pane. */
export function useTerminalPaneStoreActions() {
  return useMemo(() => {
    const state = useAppStore.getState()
    return {
      clearCodexRestartNotice: state.clearCodexRestartNotice,
      clearRuntimePaneTitle: state.clearRuntimePaneTitle,
      clearTabPtyId: state.clearTabPtyId,
      consumePendingPaneAccountRestart: state.consumePendingPaneAccountRestart,
      consumeSuppressedPtyExit: state.consumeSuppressedPtyExit,
      consumeTabIssueCommandSplit: state.consumeTabIssueCommandSplit,
      consumeTabStartupCommand: state.consumeTabStartupCommand,
      isPtyShutdownPending: state.isPtyShutdownPending,
      markTerminalBell: state.markTerminalBell,
      openSpacePage: state.openSpacePage,
      refreshWorkspaceSpace: state.refreshWorkspaceSpace,
      setCacheTimerStartedAt: state.setCacheTimerStartedAt,
      setRuntimePaneTitle: state.setRuntimePaneTitle,
      setTabCanExpandPane: state.setTabCanExpandPane,
      setTabLayout: state.setTabLayout,
      setTabLocalOnlyScrollback: state.setTabLocalOnlyScrollback,
      setTabPaneExpanded: state.setTabPaneExpanded,
      setTabViewMode: state.setTabViewMode,
      toggleTabViewMode: state.toggleTabViewMode,
      suppressPtyExit: state.suppressPtyExit,
      updateSettings: state.updateSettings,
      updateTabPtyId: state.updateTabPtyId,
      updateTabTitle: state.updateTabTitle
    }
  }, [])
}

export type TerminalPaneStoreActions = ReturnType<typeof useTerminalPaneStoreActions>

export const TERMINAL_PANE_STORE_ACTION_KEYS = [
  'clearCodexRestartNotice',
  'clearRuntimePaneTitle',
  'clearTabPtyId',
  'consumePendingPaneAccountRestart',
  'consumeSuppressedPtyExit',
  'consumeTabIssueCommandSplit',
  'consumeTabStartupCommand',
  'isPtyShutdownPending',
  'markTerminalBell',
  'openSpacePage',
  'refreshWorkspaceSpace',
  'setCacheTimerStartedAt',
  'setRuntimePaneTitle',
  'setTabCanExpandPane',
  'setTabLayout',
  'setTabLocalOnlyScrollback',
  'setTabPaneExpanded',
  'setTabViewMode',
  'toggleTabViewMode',
  'suppressPtyExit',
  'updateSettings',
  'updateTabPtyId',
  'updateTabTitle'
] as const
