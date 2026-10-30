import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatSupportedAgent } from '../../../../shared/native-chat-agent-support'
import { nativeChatAvailabilityAgent } from '../../../../shared/native-chat-availability'

export type NativeChatPaneResolutionInput = {
  /** Composite `${tabId}:${leafId}` key of the active leaf. */
  paneKey: string
  /** Launch metadata supplies the label until live status reports an agent. */
  launchAgent?: TuiAgent | null
  agentStatusEntry?: AgentStatusEntry
  ptyId: string | null
  /** Title/foreground fallback; launch metadata and hook status take precedence. */
  resolvedAgent?: TuiAgent | null
}

export type NativeChatPaneResolution = {
  agent: AgentType
  sessionId: string | null
  /** Prefer hook paths; recent Claude Code paths can diverge from session ids. */
  transcriptPath: string | null
  ptyId: string | null
  paneKey: string
}

/** Resolve agent evidence even before its provider session arrives; return null without an agent. */
export function resolveNativeChatSession(
  input: NativeChatPaneResolutionInput
): NativeChatPaneResolution | null {
  const agent = nativeChatAvailabilityAgent({
    detectedAgent: input.agentStatusEntry?.agentType,
    launchAgent: input.launchAgent,
    resolvedAgent: input.resolvedAgent
  })
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return null
  }
  return {
    agent,
    sessionId: input.agentStatusEntry?.providerSession?.id ?? null,
    transcriptPath: input.agentStatusEntry?.providerSession?.transcriptPath ?? null,
    ptyId: input.ptyId,
    paneKey: input.paneKey
  }
}
