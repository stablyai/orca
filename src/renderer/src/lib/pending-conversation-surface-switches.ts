import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'
import type { AgentPaneConversationIdentity } from '@/store/slices/agent-pane-conversation'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import { getTabIdFromPaneKey } from '@/store/slices/agent-status/agent-status-pane-key-tab-binding'

export const pendingCliChatResumes = new Map<
  AbortController,
  { key: string | null; source: CliChatResumeSource }
>()
export const pendingNativeChatCliSwitches = new Map<
  string,
  { chatTabId: string | null; workspaceId: string; executionHostId: string }
>()

export function isCliChatResumePending(key: string): boolean {
  return Array.from(pendingCliChatResumes.values()).some((operation) => operation.key === key)
}

export function protectedConversationPaneKeys(
  entries: Record<string, AgentPaneConversationIdentity>
): Set<string> {
  const protectedKeys = new Set<string>()
  for (const { source } of pendingCliChatResumes.values()) {
    protectedKeys.add(source.paneKey)
    protectedKeys.add(resolveAgentPaneAuthorityKey(source.paneKey))
  }
  const sources = [
    ...Array.from(pendingCliChatResumes.values(), ({ source }) => source),
    ...pendingNativeChatCliSwitches.values()
  ]
  for (const [key, entry] of Object.entries(entries)) {
    for (const source of sources) {
      const tabId = 'tabId' in source ? source.tabId : source.chatTabId
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
