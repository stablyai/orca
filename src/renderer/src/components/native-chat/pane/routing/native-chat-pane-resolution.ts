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
  restoredPtyId?: string
  shellForeground?: boolean
  saved?: SleepingAgentSessionRecord
  ptyId: string | null
  /** Title/foreground fallback; launch metadata and hook status take precedence. */
  resolvedAgent?: TuiAgent | null
}

export type NativeChatPaneResolution = {
  agent: AgentType
  orcaSessionId?: string | null
  sessionId: string | null
  /** Prefer hook paths; recent Claude Code paths can diverge from session ids. */
  transcriptPath: string | null
  lastBoundPtyId: string | null
  paneKey: string
}

/** Resolve agent evidence even before its provider session arrives; return null without an agent. */
export function resolveNativeChatSession(
  input: NativeChatPaneResolutionInput,
  previous?: NativeChatPaneResolution | null
): NativeChatPaneResolution | null {
  if (input.shellForeground) {
    return null
  }
  const prior = previous?.paneKey === input.paneKey ? previous : null
  const entry = input.agentStatusEntry
  const confirmed = entry && !entry.restoredUnconfirmed
  const hostId = entry?.orcaSessionId
  const differentHostSession = Boolean(
    hostId && prior?.orcaSessionId && hostId !== prior.orcaSessionId
  )
  const record = confirmed || differentHostSession ? undefined : input.saved
  const saved =
    record?.agent === 'claude' &&
    record.paneKey === input.paneKey &&
    !record.connectionId &&
    (record.origin === 'live' || record.origin === 'quit')
      ? record
      : undefined
  const agent = nativeChatAvailabilityAgent({
    detectedAgent: entry?.agentType,
    launchAgent: input.launchAgent,
    resolvedAgent: input.resolvedAgent ?? saved?.agent
  })
  const lastPty = prior?.lastBoundPtyId
  const samePty = !input.ptyId || !lastPty || input.ptyId === lastPty
  const restored = input.ptyId != null && input.restoredPtyId === input.ptyId
  const provider =
    entry?.providerSession ??
    ((samePty || restored) && saved?.agent === agent ? saved?.providerSession : undefined)
  const sameHostSession = Boolean(confirmed && hostId && hostId === prior?.orcaSessionId)
  const canRetain = provider
    ? provider.id === prior?.sessionId
    : sameHostSession || (samePty && (prior?.agent !== 'claude' || !confirmed))
  const retain =
    !differentHostSession && canRetain && (!agent || agent === prior?.agent) ? prior : null
  const currentAgent = agent ?? retain?.agent
  if (!currentAgent || !isNativeChatSupportedAgent(currentAgent)) {
    return null
  }
  return {
    agent: currentAgent,
    orcaSessionId: (entry?.providerSession && hostId) ?? retain?.orcaSessionId,
    sessionId: provider?.id ?? retain?.sessionId ?? null,
    transcriptPath: provider?.transcriptPath ?? retain?.transcriptPath ?? null,
    // Keep the last binding through detachment and unverified replacements until a session is identified.
    lastBoundPtyId:
      provider || retain ? (input.ptyId ?? lastPty ?? null) : (lastPty ?? input.ptyId),
    paneKey: input.paneKey
  }
}
