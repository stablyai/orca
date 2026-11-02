import { useCallback, useEffect } from 'react'
import type { CSSProperties } from 'react'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  isTerminalBackgroundLight,
  normalizeColor,
  resolveEffectiveTerminalAppearance,
  resolveOpaqueTerminalBackground
} from '@/lib/terminal-theme'
import { stripSshReconnectOwnedErrorLines } from './TerminalErrorToast'
import { agentLaunchPaneOutcomeForLeaf } from './agent-launch-pane-notice-text'
import { mapPaneTerminalErrors, terminalErrorForPane } from './terminal-error-accumulation'
import {
  nativeChatLaunchAgentForLeaf,
  nativeChatLeafOwnsTabWideEvidence,
  resolveNativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import { canContinueAgentSessionInNewSession } from './terminal-agent-session-continuation'
import type { TerminalPaneMobileController } from './use-terminal-pane-mobile-actions'
import type { PaneProcessExit } from './pty-connection-types'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolvePaneAgentSessionId } from './pane-agent-session-id'
import { resolvePaneHeaderSwitchOffer } from '../tab-bar/tab-session-history-switch'

/**
 * The agent the header's switch offers for: the live one only, since launch and title hints
 * outlive the agent's exit. A pane a failed switch stopped keeps the control its failure message
 * points to ("Use Switch to Chat UI to try again"), for the conversation it stopped.
 */
export function paneHeaderSwitchAgent(
  detected: string | undefined,
  processExit: PaneProcessExit | undefined
): { agent: string; stopped: boolean } | null {
  if (detected) {
    return { agent: detected, stopped: false }
  }
  return processExit?.reason === 'switch-stopped' && processExit.agent
    ? { agent: processExit.agent, stopped: true }
    : null
}

export function useTerminalPaneProjection(controller: TerminalPaneMobileController) {
  const {
    applyNativeChatLeafRoute,
    canToggleChatForLeaf,
    chatLeafId,
    contextMenu,
    contextMenuLeafId,
    effectiveChatViewMode,
    getContextMenuLeafId,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    isActive,
    isChatEligibleForLeaf,
    isChatViewMode,
    isVisible,
    managerRef,
    toggleNativeChatForLeaf,
    paneProcessExitsByPaneId,
    paneTitles,
    paneTransportsRef,
    resolveTitleAgentForLeaf,
    setTerminalError,
    setTerminalErrorsByPaneId,
    settings,
    shouldMeasureHiddenStartup,
    tabId,
    sshReconnectOwnsTerminalErrors,
    systemPrefersDark,
    tabAgentTypeByLeaf,
    terminalError,
    terminalErrorsByPaneId,
    terminalTab,
    worktreeId
  } = controller
  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  const terminalBackground = effectiveAppearance?.theme?.background
  const titleUsesLightSurface = isTerminalBackgroundLight(terminalBackground, {
    appSurface: effectiveAppearance?.mode,
    backgroundOpacity: settings?.terminalBackgroundOpacity
  })
  const paneTitleBackground =
    resolveOpaqueTerminalBackground(terminalBackground, {
      appSurface: effectiveAppearance?.mode,
      backgroundOpacity: settings?.terminalBackgroundOpacity
    }) ?? (titleUsesLightSurface ? '#ffffff' : '#000000')
  const terminalContentVisible = isVisible || shouldMeasureHiddenStartup
  const hiddenStartupStyle: CSSProperties = shouldMeasureHiddenStartup
    ? { opacity: 0, pointerEvents: 'none' }
    : {}
  const terminalContainerStyle: CSSProperties = {
    display: terminalContentVisible ? 'flex' : 'none',
    overflow: 'hidden',
    ...hiddenStartupStyle,
    ['--orca-terminal-divider-color' as string]:
      effectiveAppearance?.dividerColor ?? DEFAULT_TERMINAL_DIVIDER_DARK,
    ['--orca-terminal-divider-color-strong' as string]: normalizeColor(
      effectiveAppearance?.dividerColor,
      DEFAULT_TERMINAL_DIVIDER_DARK
    )
  }
  const activePane = managerRef.current?.getActivePane()
  const managedPanes = managerRef.current?.getPanes() ?? []
  const showSshReconnectOverlay = isActive && isVisible && sshReconnectOwnsTerminalErrors
  // SSH reconnect owns its errors even while hidden; clear only those lines after recovery.
  useEffect(() => {
    if (!sshReconnectOwnsTerminalErrors) {
      return
    }
    setTerminalError((current) =>
      current === null ? null : stripSshReconnectOwnedErrorLines(current)
    )
    setTerminalErrorsByPaneId((current) =>
      mapPaneTerminalErrors(current, stripSshReconnectOwnedErrorLines)
    )
  }, [sshReconnectOwnsTerminalErrors, setTerminalError, setTerminalErrorsByPaneId])
  const visibleTerminalError = terminalErrorForPane(
    terminalError,
    terminalErrorsByPaneId,
    activePane?.id ?? null
  )
  const visibleLaunchRefusal = agentLaunchPaneOutcomeForLeaf(terminalTab, activePane?.leafId)
  const menuPaneHasCustomTitle =
    contextMenu.menuPaneId !== null && Boolean(paneTitles[contextMenu.menuPaneId])
  const chatLeafStillMounted = chatLeafId
    ? managedPanes.some((pane) => pane.leafId === chatLeafId)
    : false
  useEffect(() => {
    const activeLeafId = activePane?.leafId ?? null
    applyNativeChatLeafRoute(
      resolveNativeChatLeafRoute({
        isChatViewMode,
        chatLeafId,
        activeLeafId,
        chatLeafStillMounted,
        activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId)
      })
    )
  }, [
    isChatViewMode,
    chatLeafId,
    activePane?.leafId,
    chatLeafStillMounted,
    applyNativeChatLeafRoute,
    isChatEligibleForLeaf
  ])
  const chatPane =
    isChatViewMode && chatLeafId
      ? (managedPanes.find((pane) => pane.leafId === chatLeafId) ?? null)
      : null
  const chatPanePtyId = chatPane
    ? (paneTransportsRef.current.get(chatPane.id)?.getPtyId() ?? null)
    : null
  const chatPaneResolvedAgent = chatPane ? resolveTitleAgentForLeaf(chatPane.leafId) : null
  const chatPaneLaunchAgent = nativeChatLaunchAgentForLeaf({
    launchAgent: terminalTab?.launchAgent,
    launchAgentLeafId: getTabWideAgentHintLeafId(),
    leafId: chatPane?.leafId ?? null,
    leafIds: getNativeChatLeafIds()
  })
  const chatPaneOwnsTabWideLaunchDraft = nativeChatLeafOwnsTabWideEvidence({
    ownerLeafId: getTabWideAgentHintLeafId(),
    leafId: chatPane?.leafId ?? null,
    leafIds: getNativeChatLeafIds()
  })
  const activePaneIsChatLeaf = Boolean(
    isChatViewMode && activePane?.leafId && activePane.leafId === chatLeafId
  )
  const resolveAgentForLeaf = (leafId: string | null): string | null => {
    const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
    if (detectedAgent) {
      return detectedAgent
    }
    return (
      nativeChatLaunchAgentForLeaf({
        launchAgent: terminalTab?.launchAgent,
        launchAgentLeafId: getTabWideAgentHintLeafId(),
        leafId,
        leafIds: getNativeChatLeafIds()
      }) ?? resolveTitleAgentForLeaf(leafId)
    )
  }
  const activeAgentId = resolveAgentForLeaf(activePane?.leafId ?? null)
  const activePaneCanContinueInNewSession = canContinueAgentSessionInNewSession(activeAgentId)
  const contextMenuCanContinueInNewSession = canContinueAgentSessionInNewSession(
    resolveAgentForLeaf(contextMenuLeafId)
  )
  // The menu switcher gates on the leaf it opened over, so mixed splits show it only where chat can render.
  const contextMenuCanToggleChat = canToggleChatForLeaf(contextMenuLeafId)
  const activeLeafId = activePane?.leafId ?? null
  // One subscription for both reads keeps the pane inside its store listener budget.
  const activeSwitchAgent = paneHeaderSwitchAgent(
    activeLeafId ? tabAgentTypeByLeaf[activeLeafId] : undefined,
    activePane ? paneProcessExitsByPaneId[activePane.id] : undefined
  )
  const { menuAgentSessionId, activePaneSwitchOffer } = useAppStore(
    useShallow((state) => ({
      menuAgentSessionId:
        contextMenu.open && contextMenuLeafId
          ? resolvePaneAgentSessionId(state, makePaneKey(tabId, contextMenuLeafId))
          : null,
      // Cheap stand-in for the tab menu's gate, on this pane's own conversation; the click looks it up.
      activePaneSwitchOffer:
        !activePaneIsChatLeaf && activeLeafId !== null
          ? resolvePaneHeaderSwitchOffer(state, {
              worktreeId,
              paneKey: makePaneKey(tabId, activeLeafId),
              liveAgent: activeSwitchAgent?.agent ?? null,
              stopped: activeSwitchAgent?.stopped
            })
          : null
    }))
  )
  const contextMenuIsChatView = effectiveChatViewMode && contextMenuLeafId === chatLeafId
  const handleContextMenuToggleNativeChat = useCallback(() => {
    const leafId = getContextMenuLeafId()
    if (!leafId) {
      return
    }
    toggleNativeChatForLeaf(leafId)
  }, [getContextMenuLeafId, toggleNativeChatForLeaf])
  return {
    effectiveAppearance,
    terminalBackground,
    titleUsesLightSurface,
    paneTitleBackground,
    terminalContentVisible,
    hiddenStartupStyle,
    terminalContainerStyle,
    activePane,
    managedPanes,
    showSshReconnectOverlay,
    visibleLaunchRefusal,
    visibleTerminalError,
    menuPaneHasCustomTitle,
    menuAgentSessionId,
    chatLeafStillMounted,
    chatPane,
    chatPanePtyId,
    chatPaneResolvedAgent,
    chatPaneLaunchAgent,
    chatPaneOwnsTabWideLaunchDraft,
    activePaneIsChatLeaf,
    activeAgentId,
    resolveAgentForLeaf,
    activePaneCanContinueInNewSession,
    contextMenuCanContinueInNewSession,
    activePaneSwitchOffer,
    contextMenuCanToggleChat,
    contextMenuIsChatView,
    handleContextMenuToggleNativeChat
  }
}

export type TerminalPaneProjectionController = TerminalPaneMobileController &
  ReturnType<typeof useTerminalPaneProjection>
