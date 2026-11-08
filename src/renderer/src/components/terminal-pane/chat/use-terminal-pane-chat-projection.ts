import { useCallback, useEffect } from 'react'
import {
  nativeChatLaunchAgentForLeaf,
  nativeChatLeafOwnsTabWideEvidence,
  resolveNativeChatLeafRoute
} from '../../native-chat/pane/routing/native-chat-leaf-routing'
import { canContinueAgentSessionInNewSession } from '../session-continuation/terminal-agent-session-continuation'
import type { TerminalPaneMobileController } from '../controller/use-terminal-pane-mobile-actions'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { resolvePaneAgentSessionId } from '../../../lib/agent-session/identity/pane-agent-session-id'
import { canPaneOfferResumeInNewChat } from '../../tab-bar/tab-session-history-switch'

export function useTerminalPaneChatProjection({
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
}: Pick<
  TerminalPaneMobileController,
  | 'applyNativeChatLeafRoute'
  | 'canToggleChatForLeaf'
  | 'chatLeafId'
  | 'contextMenu'
  | 'contextMenuLeafId'
  | 'effectiveChatViewMode'
  | 'getContextMenuLeafId'
  | 'getNativeChatLeafIds'
  | 'getTabWideAgentHintLeafId'
  | 'isChatEligibleForLeaf'
  | 'isChatViewMode'
  | 'toggleNativeChatForLeaf'
  | 'paneTransportsRef'
  | 'resolveTitleAgentForLeaf'
  | 'tabId'
  | 'tabAgentTypeByLeaf'
  | 'terminalTab'
  | 'worktreeId'
> & {
  activePane:
    | ReturnType<
        NonNullable<TerminalPaneMobileController['managerRef']['current']>['getActivePane']
      >
    | undefined
  managedPanes: ReturnType<
    NonNullable<TerminalPaneMobileController['managerRef']['current']>['getPanes']
  >
}) {
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
  const { menuAgentSessionId, activePaneCanResumeInChat } = useAppStore(
    useShallow((state) => ({
      menuAgentSessionId:
        contextMenu.open && contextMenuLeafId
          ? resolvePaneAgentSessionId(state, makePaneKey(tabId, contextMenuLeafId))
          : null,
      // Cheap stand-in for the tab menu's gate, on this pane's own conversation; the click looks it up.
      activePaneCanResumeInChat:
        !activePaneIsChatLeaf &&
        activeLeafId !== null &&
        canPaneOfferResumeInNewChat(state, {
          worktreeId,
          paneKey: makePaneKey(tabId, activeLeafId)
        })
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
    activePaneCanResumeInChat,
    contextMenuCanToggleChat,
    contextMenuIsChatView,
    handleContextMenuToggleNativeChat
  }
}
