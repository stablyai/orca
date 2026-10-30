// Reconcile live working state with provider turn boundaries so a dropped final hook cannot leave Stop stuck.

import type { AgentStatusEntry, AgentStatusState } from '../agent-status-types'
import { isAgentStatusFresh } from '../agent-status-freshness'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatSession,
  NativeChatSessionStatus,
  NativeChatTurnLifecycle
} from '../native-chat-types'
import { LIFECYCLE_CLOCK_SKEW_SLACK_MS } from '../native-chat-clock-skew'

export type NativeChatLiveMergeInput = {
  /** Already deduped, ordered, and transcript-normalized by the live assembler. */
  messages: NativeChatMessage[]
  sessionId: string | null
  agent: AgentType
  /** Live hook state for the pane, or null when no hook entry exists. */
  hookState: AgentStatusState | null
  /** Epoch ms when the current hook state began, or null when unknown. */
  stateStartedAt?: number | null
  /** Latest provider-authored turn boundary recovered from the transcript. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** Transcript tail before presentation normalization or canonical re-dedup. */
  statusTailMessage?: NativeChatMessage
  /** Claude can finish its lead turn while background children remain active. */
  hookHasWorkingSubagents?: boolean
  /** Before initial snapshot resolution, loading overrides non-working status. */
  loading?: boolean
  /** Set when the initial snapshot failed; forces 'error'. */
  error?: string
}

export type NativeChatLiveMergedSession = NativeChatSession & { hookAwaitingInput: boolean }

/** Errors win; working hooks override loading until their turn ends, with provider lifecycle settling dropped Stop hooks. */
export function mergeNativeChatLiveSession(
  input: NativeChatLiveMergeInput
): NativeChatLiveMergedSession {
  const {
    messages,
    sessionId,
    agent,
    hookState,
    stateStartedAt,
    transcriptLifecycle,
    statusTailMessage,
    hookHasWorkingSubagents,
    loading,
    error
  } = input
  const hookAwaitingInput = nativeChatHookAwaitsInput(
    hookState,
    stateStartedAt,
    transcriptLifecycle
  )
  if (error) {
    return { messages, status: 'error', sessionId, agent, error, hookAwaitingInput }
  }

  const status = liveStatusOverride(
    agent,
    hookState,
    statusTailMessage ?? messages.at(-1),
    stateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents ?? false
  )
  // Keep Stop/activity live while loading; view-state selection separately holds empty transcripts on their loading surface.
  if (loading && status !== 'working') {
    return { messages, status: 'loading', sessionId, agent, hookAwaitingInput }
  }
  return {
    messages,
    status: status ?? (messages.length === 0 ? 'empty' : 'ready'),
    sessionId,
    agent,
    hookAwaitingInput
  }
}

/** Restored nonterminal rows need a live hook confirmation before they may keep chat busy. */
export function resolveNativeChatHookState(
  entry:
    | Pick<AgentStatusEntry, 'state' | 'workingMode' | 'updatedAt' | 'restoredUnconfirmed'>
    | undefined
    | null,
  now = Date.now()
): AgentStatusState | null {
  if (!entry || !isAgentStatusFresh(entry, now)) {
    return null
  }
  return entry.state === 'working' && entry.workingMode === 'monitoring' ? null : entry.state
}

/** Only children started in this parent epoch may delay settlement; missed stops and reused panes leave stale roster entries. */
export function nativeChatHookHasWorkingSubagents(
  entry: Pick<AgentStatusEntry, 'stateStartedAt' | 'subagents'> | undefined | null
): boolean {
  const epochStart = entry?.stateStartedAt
  return (
    entry?.subagents?.some(
      (subagent) =>
        subagent.state === 'working' && (epochStart == null || subagent.startedAt >= epochStart)
    ) ?? false
  )
}

/** blocked/waiting needs human input; a transcript terminal marker can clear waits whose interrupt emitted no hook. */
export function nativeChatHookAwaitsInput(
  hookState: AgentStatusState | null,
  stateStartedAt: number | null | undefined,
  transcriptLifecycle: NativeChatTurnLifecycle | undefined
): boolean {
  return (
    (hookState === 'blocked' || hookState === 'waiting') &&
    !lifecycleTerminatesCurrentTurn(transcriptLifecycle, stateStartedAt)
  )
}

/** omp retries its own agent_end hook, so trailing mid-run prose/tool rows cannot stand in for a lost end signal. */
function hookDeliversTurnEnd(agent: AgentType): boolean {
  return agent === 'omp'
}

function liveStatusOverride(
  agent: AgentType,
  hookState: AgentStatusState | null,
  statusTailMessage: NativeChatMessage | undefined,
  stateStartedAt: number | null | undefined,
  transcriptLifecycle: NativeChatTurnLifecycle | undefined,
  hookHasWorkingSubagents: boolean
): NativeChatSessionStatus | undefined {
  // Only 'working' drives a live override; blocked/waiting/done leave the
  // derived (ready/empty) status alone so completed turns render normally.
  if (hookState !== 'working') {
    return undefined
  }
  const terminatesCurrentTurn = lifecycleTerminatesCurrentTurn(transcriptLifecycle, stateStartedAt)
  // Explicit interruption ends the aggregate turn even if stale child status still reports work.
  if (terminatesCurrentTurn && transcriptLifecycle?.state === 'interrupted') {
    return undefined
  }
  // Claude lead completion leaves current-epoch children working; callers must exclude older rosters.
  if (hookHasWorkingSubagents) {
    return 'working'
  }
  if (terminatesCurrentTurn) {
    return undefined
  }
  // Use prose recovery only without an explicit working lifecycle; partial live prose must not settle capable providers early.
  if (
    transcriptLifecycle?.state !== 'working' &&
    !hookDeliversTurnEnd(agent) &&
    trailingAssistantPostDates(statusTailMessage, stateStartedAt)
  ) {
    return undefined
  }
  return 'working'
}

function lifecycleTerminatesCurrentTurn(
  lifecycle: NativeChatTurnLifecycle | undefined,
  stateStartedAt: number | null | undefined
): boolean {
  if (lifecycle?.state !== 'completed' && lifecycle?.state !== 'interrupted') {
    return false
  }
  // Missing timestamps are valid; latest lifecycle wins because a newer user generation would have replaced it with working.
  if (stateStartedAt == null || lifecycle.timestamp == null) {
    return true
  }
  if (lifecycle.timestamp >= stateStartedAt) {
    return true
  }
  // Apply clock slack only to real epoch timestamps; logical clocks retain strict ordering.
  if (lifecycle.timestamp > 1e11 && stateStartedAt > 1e11) {
    return lifecycle.timestamp + LIFECYCLE_CLOCK_SKEW_SLACK_MS >= stateStartedAt
  }
  return false
}

function trailingAssistantPostDates(
  message: NativeChatMessage | undefined,
  stateStartedAt: number | null | undefined
): boolean {
  if (stateStartedAt == null) {
    return false
  }
  return (
    message?.role === 'assistant' &&
    message.timestamp != null &&
    message.timestamp >= stateStartedAt
  )
}
