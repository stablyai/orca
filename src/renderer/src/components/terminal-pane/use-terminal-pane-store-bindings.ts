import { useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import { isWindowsUserAgent } from './pane-helpers'
import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import type { TerminalPaneChatController } from './use-terminal-pane-chat-state'

export function useTerminalPaneStoreBindings(controller: TerminalPaneChatController) {
  const { expectedLayoutLeafIds, isVisible, restoredLayout, tabId } = controller
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
  const [startup] = useState(() => useAppStore.getState().pendingStartupByTabId[tabId])
  const [shouldMeasureHiddenStartup, setShouldMeasureHiddenStartup] = useState(
    () => startup !== undefined && !isVisible
  )
  const [sessionRestoredBannerPaneIds, setSessionRestoredBannerPaneIds] = useState<
    Map<number, SessionRestoredBannerReason>
  >(() => new Map())
  const [issueCommandSplit] = useState(
    () => useAppStore.getState().pendingIssueCommandSplitByTabId[tabId]
  )

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
