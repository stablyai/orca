import { useTerminalStartupMeasurementState } from '../mounting/use-terminal-startup-measurement-state'
import { useRestoredBannerPaneState } from '../session-restore/use-restored-banner-pane-state'
import { useQueuedIssueCommandSplit } from '../layout/split/use-queued-issue-command-split'
import { useRef } from 'react'
import { useAppStore } from '../../../store/index'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog-context'
import { isWindowsUserAgent } from '../../../app-shell/platform/user-agent-platform'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import type { TerminalPaneChatController } from '../chat/use-terminal-pane-chat-state'

export function useTerminalPaneStoreBindings(controller: TerminalPaneChatController) {
  const { expectedLayoutLeafIds, isVisible, measureWhileHidden, restoredLayout, tabId } = controller
  const {
    clearRuntimePaneTitle,
    clearTabPtyId,
    consumeTabIssueCommandSplit,
    consumeTabStartupCommand,
    markTerminalBell,
    openSpacePage,
    refreshWorkspaceSpace,
    setRuntimePaneTitle,
    setTabLayout,
    setTabLocalOnlyScrollback,
    updateSettings,
    updateTabPtyId,
    updateTabTitle
  } = useTerminalPaneStoreActions()
  const expectedLayoutLeafIdsAttr =
    expectedLayoutLeafIds.length > 0 ? expectedLayoutLeafIds.join(' ') : undefined
  const initialLayoutRef = useRef(restoredLayout)
  const settings = useAppStore((store) => store.settings)
  const requestLinkRoutingPreference = useLinkRoutingPreferenceDialog()
  const keybindings = useAppStore((store) => store.keybindings)
  const rightClickToPaste = settings?.terminalRightClickToPaste ?? isWindowsUserAgent()
  const forceBracketedMultilineTextPaste = isWindowsUserAgent()

  const { startup, shouldMeasureHiddenStartup, setShouldMeasureHiddenStartup } =
    useTerminalStartupMeasurementState({ isVisible, measureWhileHidden, tabId })

  const { sessionRestoredBannerPaneIds, setSessionRestoredBannerPaneIds } =
    useRestoredBannerPaneState()

  const { issueCommandSplit } = useQueuedIssueCommandSplit({ tabId })

  return {
    setTabLayout,
    setTabLocalOnlyScrollback,
    expectedLayoutLeafIdsAttr,
    initialLayoutRef,
    updateTabTitle,
    setRuntimePaneTitle,
    clearRuntimePaneTitle,
    updateTabPtyId,
    clearTabPtyId,
    markTerminalBell,
    openSpacePage,
    refreshWorkspaceSpace,
    settings,
    updateSettings,
    requestLinkRoutingPreference,
    keybindings,
    rightClickToPaste,
    forceBracketedMultilineTextPaste,
    startup,
    shouldMeasureHiddenStartup,
    setShouldMeasureHiddenStartup,
    sessionRestoredBannerPaneIds,
    setSessionRestoredBannerPaneIds,
    consumeTabStartupCommand,
    issueCommandSplit,
    consumeTabIssueCommandSplit
  }
}

export type TerminalPaneStoreController = TerminalPaneChatController &
  ReturnType<typeof useTerminalPaneStoreBindings>
