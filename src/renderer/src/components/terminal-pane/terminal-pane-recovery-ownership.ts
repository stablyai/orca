import { useAppStore } from '@/store'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { findRegisteredTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { nativeChatPresentationPolicy } from '../../../../shared/native-chat-availability'
import {
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import { collectLeafIdsInOrder } from './layout-serialization'
import { paneIsCoveredByNativeChat } from './native-chat-covered-pane'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
import { selectTerminalTabAgentTypesByLeaf } from './terminal-tab-agent-type-index'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import { selectUnifiedTerminalTabFields } from './terminal-unified-tab-lookup'
import { selectTerminalPaneHostState } from './terminal-pane-host-state'

/** Remount replaces every pane; saved intent alone does not establish a chat owner. */
export function canRemountTerminalPaneWithoutChatOwner(
  worktreeId: string,
  tabId: string,
  manager: PaneManager
): boolean {
  const registered = findRegisteredTerminalTab(tabId, worktreeId)?.tab
  if (registered?.getManager() !== manager) {
    return false
  }
  const state = useAppStore.getState()
  const terminalTab = getCachedTerminalTabForWorktree(state.tabsByWorktree, worktreeId, tabId)
  const panes = manager.getPanes()
  if (!terminalTab || panes.length === 0 || panes.some(paneIsCoveredByNativeChat)) {
    return false
  }
  const unified = selectUnifiedTerminalTabFields(state.unifiedTabsByWorktree, worktreeId, tabId)
  if (terminalTab.viewMode !== 'chat' && !unified.isChatViewMode) {
    return true
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  const leafIds = [
    ...new Set([...collectLeafIdsInOrder(layout?.root ?? null), ...panes.map((p) => p.leafId)])
  ]
  const hintLeafId = registered.getTabWideAgentHintLeafId()
  const agents = selectTerminalTabAgentTypesByLeaf(
    state.agentStatusByPaneKey,
    tabId,
    state.paneForegroundAgentByPaneKey
  )
  const host = selectTerminalPaneHostState(state, worktreeId)
  const disposition = (leafId: string | null) => {
    const detectedAgent = leafId ? (agents[leafId] ?? null) : null
    const soleLeaf = leafIds.length === 1 && hintLeafId === leafId
    return nativeChatPresentationPolicy({
      contentType: 'terminal',
      isWslProject: host.nativeChatIsWslProject,
      nativeChatTranscriptIsLocalReadable: host.nativeChatTranscriptIsLocalReadable,
      detectedAgent,
      launchAgent: detectedAgent
        ? null
        : nativeChatLaunchAgentForLeaf({
            launchAgent: terminalTab.launchAgent,
            launchAgentLeafId: hintLeafId,
            leafId,
            leafIds
          }),
      resolvedAgent: detectedAgent
        ? null
        : resolveNativeChatLeafTitleAgent({
            leafId,
            panes,
            runtimePaneTitlesByPaneId: state.runtimePaneTitlesByTabId[tabId] ?? {},
            tabLabel: soleLeaf ? unified.unifiedTabLabel : null,
            terminalTitle: soleLeaf ? terminalTab.title : null
          })
    }).saved
  }
  const activeLeafId = manager.getActivePane()?.leafId ?? null
  const chatLeafId = layout?.chatLeafId ?? null
  const route = resolveNativeChatLeafRoute({
    isChatViewMode: true,
    savedOwnerDisposition: disposition(chatLeafId ?? activeLeafId),
    chatLeafId,
    activeLeafId,
    chatLeafStillMounted: panes.some((pane) => pane.leafId === chatLeafId),
    activeLeafDisposition: disposition(activeLeafId)
  })
  // Re-derive acquisition before the projection effect/cover commits, including inactive owners.
  return route.chatLeafId === null
}
