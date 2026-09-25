import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { findStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { useAppStore } from '@/store'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'

/** Why not the legacy seed: its mirror cap exists because a TUI cannot clear more than forty lines,
 *  and a structured session has no TUI copy, so a gated seed here would be a lost prompt. */
export function seedStructuredAgentLaunchDraft(
  tabId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): void {
  if (options.promptDelivery !== 'draft' || !options.prompt) {
    return
  }
  useAppStore.getState().seedNativeChatLaunchDraft({
    tabId,
    agent,
    text: options.prompt,
    createdAt: Date.now()
  })
}

export function clearStructuredAgentLaunchDraftForSession(
  worktreeId: string,
  sessionId: string
): void {
  const state = useAppStore.getState()
  const tab = findStructuredAgentSessionTab(state.unifiedTabsByWorktree, {
    workspaceId: worktreeId,
    sessionId
  })
  if (tab) {
    state.clearNativeChatLaunchDraft(tab.id)
  }
}
