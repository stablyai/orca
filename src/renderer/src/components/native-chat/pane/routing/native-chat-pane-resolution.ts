import type {
  AgentStatusEntry,
  AgentType
} from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { isNativeChatSupportedAgent } from '../../../../../../shared/native-chat/native-chat-agent-support'
import { nativeChatAvailabilityAgent } from '../../../../../../shared/native-chat/native-chat-availability'

export type NativeChatPaneResolutionInput = {
  /** Composite `${tabId}:${leafId}` key of the active leaf. */
  paneKey: string
  /** Launch metadata supplies the label until live status reports an agent. */
  launchAgent?: TuiAgent | null
  agentStatusEntry?: AgentStatusEntry
  saved?: SleepingAgentSessionRecord
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
  const record = input.saved
  const saved =
    record?.agent === 'claude' &&
    record.paneKey === input.paneKey &&
    !record.connectionId &&
    (record.origin === 'live' || record.origin === 'quit')
      ? record
      : undefined
  const agent = nativeChatAvailabilityAgent({
    detectedAgent: input.agentStatusEntry?.agentType,
    launchAgent: input.launchAgent,
    resolvedAgent: input.resolvedAgent ?? saved?.agent
  })
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return null
  }
  const provider =
    input.agentStatusEntry?.providerSession ??
    (saved?.agent === agent ? saved.providerSession : undefined)
  return {
    agent,
    sessionId: provider?.id ?? null,
    transcriptPath: provider?.transcriptPath ?? null,
    ptyId: input.ptyId,
    paneKey: input.paneKey
  }
}
