import type { AgentPaneConversationIdentity } from '@/store/slices/agent-pane-conversation'
import { getTabIdFromPaneKey } from '@/store/slices/agent-status/agent-status-pane-key-tab-binding'

export const pendingNativeChatCliSwitches = new Map<
  string,
  { chatTabId: string | null; workspaceId: string; executionHostId: string }
>()

export function protectedConversationPaneKeys(
  entries: Record<string, AgentPaneConversationIdentity>
): Set<string> {
  const protectedKeys = new Set<string>()
  for (const [key, entry] of Object.entries(entries)) {
    for (const source of pendingNativeChatCliSwitches.values()) {
      const tabId = source.chatTabId
      if (
        tabId !== null &&
        getTabIdFromPaneKey(key) === tabId &&
        entry.worktreeId === source.workspaceId &&
        entry.executionHostId === source.executionHostId
      ) {
        protectedKeys.add(key)
      }
    }
  }
  return protectedKeys
}

const listeners = new Set<() => void>()
export const conversationSwitchChanged = () => listeners.forEach((listener) => listener())
export const subscribeConversationSwitch = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
