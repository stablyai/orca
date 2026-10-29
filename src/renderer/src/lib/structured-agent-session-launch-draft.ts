import type { TuiAgent } from '../../../shared/tui-agent'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'

/** Structured chats have no TUI mirror; the legacy forty-line cap would drop prompts instead of protecting TUI clearing. */
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
