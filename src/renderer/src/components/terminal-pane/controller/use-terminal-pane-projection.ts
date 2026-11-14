import { resolveTerminalPaneAppearance } from '../appearance/resolve-terminal-pane-appearance'
import { useSshReconnectErrorOwnership } from '../errors/use-ssh-reconnect-error-ownership'
import { useTerminalPaneChatProjection } from '../chat/use-terminal-pane-chat-projection'

import { agentLaunchPaneOutcomeForLeaf } from '../launch-outcome/agent-launch-pane-notice-text'
import { terminalErrorForPane } from '../errors/terminal-error-accumulation'

import type { TerminalPaneMobileController } from './use-terminal-pane-mobile-actions'
import { useAppStore } from '@/store'
import { resolvePaneHeaderButtonsOnHover } from '../titles/terminal-pane-header-buttons-mode'

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
    terminalManager,
    toggleNativeChatForLeaf,
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

  const {
    effectiveAppearance,
    terminalBackground,
    titleUsesLightSurface,
    paneTitleBackground,
    terminalContentVisible,
    hiddenStartupStyle,
    terminalContainerStyle
  } = resolveTerminalPaneAppearance({
    isVisible,
    settings,
    shouldMeasureHiddenStartup,
    systemPrefersDark
  })
  const activeContextualTourId = useAppStore((state) => state.activeContextualTourId)
  const paneHeaderButtonsOnHover = resolvePaneHeaderButtonsOnHover(
    settings?.terminalPaneHeaderButtons,
    activeContextualTourId
  )
  const activePane = terminalManager?.getActivePane()
  const managedPanes = terminalManager?.getPanes() ?? []
  const activePaneRuntimeEnvironmentId = activePane
    ? (paneTransportsRef.current.get(activePane.id)?.getRuntimeEnvironmentId?.() ?? null)
    : undefined
  const showSshReconnectOverlay = isActive && isVisible && sshReconnectOwnsTerminalErrors

  useSshReconnectErrorOwnership({
    setTerminalError,
    setTerminalErrorsByPaneId,
    sshReconnectOwnsTerminalErrors
  })
  const visibleTerminalError = terminalErrorForPane(
    terminalError,
    terminalErrorsByPaneId,
    activePane?.id ?? null
  )
  const visibleLaunchRefusal = agentLaunchPaneOutcomeForLeaf(terminalTab, activePane?.leafId)
  const menuPaneHasCustomTitle =
    contextMenu.menuPaneId !== null && Boolean(paneTitles[contextMenu.menuPaneId])

  const {
    menuAgentSessionId,
    menuAgentIdAvailable,
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
    activePaneCanResumeInChat,
    contextMenuCanToggleChat,
    contextMenuIsChatView,
    handleContextMenuToggleNativeChat
  } = useTerminalPaneChatProjection({
    applyNativeChatLeafRoute,
    canToggleChatForLeaf,
    chatLeafId,
    contextMenu,
    contextMenuLeafId,
    effectiveChatViewMode,
    getContextMenuLeafId,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    isChatEligibleForLeaf,
    isChatViewMode,
    toggleNativeChatForLeaf,
    paneTransportsRef,
    resolveTitleAgentForLeaf,
    tabId,
    tabAgentTypeByLeaf,
    terminalTab,
    worktreeId,
    activePane,
    managedPanes
  })
  return {
    effectiveAppearance,
    terminalBackground,
    titleUsesLightSurface,
    paneTitleBackground,
    paneHeaderButtonsOnHover,
    terminalContentVisible,
    hiddenStartupStyle,
    terminalContainerStyle,
    activePane,
    activePaneRuntimeEnvironmentId,
    managedPanes,
    showSshReconnectOverlay,
    visibleLaunchRefusal,
    visibleTerminalError,
    menuPaneHasCustomTitle,
    menuAgentIds: { sessionId: menuAgentSessionId, agentIdAvailable: menuAgentIdAvailable },
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
    activePaneCanResumeInChat,
    contextMenuCanToggleChat,
    contextMenuIsChatView,
    handleContextMenuToggleNativeChat
  }
}

export type TerminalPaneProjectionController = TerminalPaneMobileController &
  ReturnType<typeof useTerminalPaneProjection>
