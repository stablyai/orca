import type { TuiAgent } from '../../../shared/tui-agent'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'

/** Why not the legacy seed: its mirror cap exists because a TUI cannot clear more than forty lines,
 *  and a structured session has no TUI copy, so a gated seed here would be a lost prompt. */
export function seedStructuredAgentLaunchDraft(
  sessionId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions
): void {
  if (options.promptDelivery !== 'draft' || !options.prompt) {
    return
  }
  useAppStore.getState().seedNativeChatLaunchDraft({
    tabId: structuredAgentSessionTabId(sessionId),
    agent,
    text: options.prompt,
    createdAt: Date.now()
  })
}

export function clearStructuredAgentLaunchDraft(sessionId: string): void {
  useAppStore.getState().clearNativeChatLaunchDraft(structuredAgentSessionTabId(sessionId))
}
