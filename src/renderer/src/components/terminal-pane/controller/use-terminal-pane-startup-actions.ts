import { useQueuedTabStartupAcknowledgement } from '../mounting/use-queued-tab-startup-acknowledgement'
import { useVisibleTerminalMeasurement } from '../viewport/use-visible-terminal-measurement'
import { useIssueCommandSplitSettlement } from '../layout/split/use-issue-command-split-settlement'
import { useRestoredSessionBannerActions } from '../session-restore/use-restored-session-banner-actions'
import { useTerminalSessionSaveRecovery } from '../errors/use-terminal-session-save-recovery'
import { useTerminalQuickCommandEditor } from '../quick-commands/use-terminal-quick-command-editor'
import { useTerminalLinkRoutingPreference } from '../links/use-terminal-link-routing-preference'
import { useRef } from 'react'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'

import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import type { MacOptionAsAlt } from '../input/keyboard/terminal-option-shortcut-policy'
import { useSystemPrefersDark } from '../../../hooks/theme/use-system-prefers-dark'
import { useNotificationDispatch } from '../notifications/use-notification-dispatch'
import type { TerminalPaneStoreController } from './use-terminal-pane-store-bindings'

export function useTerminalPaneStartupActions(controller: TerminalPaneStoreController) {
  const {
    consumeTabIssueCommandSplit,
    consumeTabStartupCommand,
    containerRef,
    issueCommandSplit,
    isVisible,
    managerRef,
    onPtyExit,
    openSpacePage,
    quickCommandEditorHostId,
    refreshWorkspaceSpace,
    requestLinkRoutingPreference,
    sessionRestoredBannerPaneIds,
    setQuickCommandDraft,
    setQuickCommandEditorHostId,
    setQuickCommandEditorOpen,
    setSessionRestoredBannerPaneIds,
    setSessionStateSaveFailureMessage,
    setShouldMeasureHiddenStartup,
    setTerminalError,
    setTerminalErrorsByPaneId,
    settings,
    shouldMeasureHiddenStartup,
    startup,
    tabId,
    updateSettings,
    worktreeId
  } = controller

  const { settleTabStartupCommand } = useQueuedTabStartupAcknowledgement({
    consumeTabStartupCommand,
    startup,
    tabId
  })

  useVisibleTerminalMeasurement({
    isVisible,
    setShouldMeasureHiddenStartup,
    setTerminalError,
    setTerminalErrorsByPaneId,
    shouldMeasureHiddenStartup
  })
  const {
    clearSessionRestoredBannerForPane,
    showRestoredSessionBanner,
    dismissSessionRestoredBanner
  } = useRestoredSessionBannerActions({
    setSessionRestoredBannerPaneIds,
    managerRef,
    sessionRestoredBannerPaneIds,
    containerRef
  })
  const { openDiskSpaceAnalyzer } = useTerminalSessionSaveRecovery({
    setSessionStateSaveFailureMessage,
    openSpacePage,
    refreshWorkspaceSpace
  })
  const {
    quickCommandRepoId,
    quickCommandRepoLabel,
    quickCommandGroupId,
    openQuickCommandEditor,
    saveQuickCommand
  } = useTerminalQuickCommandEditor({
    worktreeId,
    tabId,
    setQuickCommandDraft,
    setQuickCommandEditorHostId,
    setQuickCommandEditorOpen,
    quickCommandEditorHostId
  })

  useIssueCommandSplitSettlement({ consumeTabIssueCommandSplit, issueCommandSplit, tabId })

  const settingsRef = useRef(settings)
  // Startup callbacks can run before the next effect commit.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  settingsRef.current = settings
  const { requestOpenLinksInAppPreference } = useTerminalLinkRoutingPreference({
    requestLinkRoutingPreference,
    updateSettings,
    settingsRef
  })
  const effectiveMacOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  const macOptionAsAltRef = useRef<MacOptionAsAlt>(effectiveMacOptionAsAlt)
  // Keyboard listeners need the current preference without a render lag.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  macOptionAsAltRef.current = effectiveMacOptionAsAlt
  const onPtyExitRef = useRef(onPtyExit)
  // PTY teardown may call this ref before passive effects flush.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  onPtyExitRef.current = onPtyExit
  const systemPrefersDark = useSystemPrefersDark()
  const dispatchNotification = useNotificationDispatch(worktreeId)
  const { setCacheTimerStartedAt } = useTerminalPaneStoreActions()

  return {
    clearSessionRestoredBannerForPane,
    showRestoredSessionBanner,
    dismissSessionRestoredBanner,
    openDiskSpaceAnalyzer,
    quickCommandRepoId,
    quickCommandRepoLabel,
    quickCommandGroupId,
    openQuickCommandEditor,
    saveQuickCommand,
    settleTabStartupCommand,
    settingsRef,
    requestOpenLinksInAppPreference,
    effectiveMacOptionAsAlt,
    macOptionAsAltRef,
    onPtyExitRef,
    systemPrefersDark,
    dispatchNotification,
    setCacheTimerStartedAt
  }
}

export type TerminalPaneStartupController = TerminalPaneStoreController &
  ReturnType<typeof useTerminalPaneStartupActions>
