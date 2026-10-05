import { useShallow } from 'zustand/react/shallow'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '../../store'
import { findHostLeafConversation } from './native-chat-leaf-conversation-identity'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'

export function useNativeChatStatusEntry(
  terminalTabId: string,
  preferredPaneKey: string | undefined
) {
  const entry = useAppStore(
    useShallow((state) =>
      preferredPaneKey
        ? state.agentStatusByPaneKey[preferredPaneKey]
        : findTabAgentEntry(state.agentStatusByPaneKey, terminalTabId)
    )
  )
  const paneKey = preferredPaneKey ?? entry?.paneKey ?? `${terminalTabId}:`
  const leafId = parsePaneKey(paneKey)?.leafId
  // Why the mirrored entry itself: no allocation per store update; it changes with the worktree's tabs.
  const conversation = useAppStore((state) =>
    findHostLeafConversation(state.tabsByWorktree, terminalTabId, leafId)
  )
  return { entry, paneKey, conversation }
}
