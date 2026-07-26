// Pure merge of live hook turn-state into a NativeChatSession status override.
// Kept separate from the React hook so the precedence rule (live 'working'
// surfaces before the transcript flushes its explicit terminal record, then is
// reconciled once that boundary lands) is unit-testable without IPC.

import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { assembleNativeChatSession, type NativeChatSources } from './native-chat-session-assembler'
import type {
  AgentType,
  NativeChatSession,
  NativeChatSessionStatus,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'

export type NativeChatLiveMergeInput = {
  sources: NativeChatSources
  sessionId: string | null
  agent: AgentType
  /** Live hook state for the pane, or null when no hook entry exists. */
  hookState: AgentStatusState | null
  /** Epoch ms when the current hook state began, or null when unknown. */
  stateStartedAt?: number | null
  /** Latest provider-authored turn boundary recovered from the transcript. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** Claude can finish its lead turn while background children remain active. */
  hookHasWorkingSubagents?: boolean
  /** True before the initial snapshot resolves; forces 'loading'. */
  loading?: boolean
  /** Set when the initial snapshot failed; forces 'error'. */
  error?: string
}

/**
 * Decide the session status given the merged transcript/append messages and the
 * live hook state. The transcript is the source of truth for content; explicit
 * provider lifecycle records reconcile a dropped final hook.
 *
 * Precedence:
 *   - errors win outright; live work wins over transcript loading.
 *   - hook 'working' stays authoritative until the hook exits that state OR an
 *     explicit terminal marker for this turn lands.
 *   - design is hook-first: lifecycle is a terminal suppressor for dropped
 *     Stop hooks, not a full authority for active-turn reconstruction.
 */
export function mergeNativeChatLiveSession(input: NativeChatLiveMergeInput): NativeChatSession {
  const {
    sources,
    sessionId,
    agent,
    hookState,
    stateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents,
    loading,
    error
  } = input
  if (error) {
    return assembleNativeChatSession({ sources, sessionId, agent, status: 'error', error })
  }

  const status = liveStatusOverride(
    hookState,
    sources,
    stateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents ?? false
  )
  if (loading && status !== 'working') {
    return assembleNativeChatSession({ sources, sessionId, agent, status: 'loading' })
  }
  return assembleNativeChatSession({
    sources,
    sessionId,
    agent,
    ...(status ? { status } : {})
  })
}

/** Slack for comparing transcript timestamps to hook receipt times across hosts. */
const LIFECYCLE_CLOCK_SKEW_SLACK_MS = 2_000

function liveStatusOverride(
  hookState: AgentStatusState | null,
  sources: NativeChatSources,
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
  // Why: an explicit interruption ends the whole turn, children included, so it
  // settles the session even while a stale child status still reads working.
  if (terminatesCurrentTurn && transcriptLifecycle?.state === 'interrupted') {
    return undefined
  }
  // Why: a lead completion does not end Claude's aggregate turn while a
  // background child still runs; callers must already scope the roster to the
  // current working epoch so prior-turn children cannot veto forever.
  if (hookHasWorkingSubagents) {
    return 'working'
  }
  if (terminatesCurrentTurn) {
    return undefined
  }
  // Why: prose recovery stays available whenever the latest lifecycle is not an
  // explicit in-progress generation. That covers incapable hosts and capable
  // hosts whose transcript never emitted a terminal marker for this window.
  // Mid-turn (lifecycle === working) keeps prose off so partial assistant rows
  // do not settle early on capable providers.
  if (
    transcriptLifecycle?.state !== 'working' &&
    trailingAssistantPostDates(sources, stateStartedAt)
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
  // Why: omit/null timestamps are valid on the wire. Prefer the terminal marker
  // over a stuck spinner — the latest lifecycle is already last-wins from the
  // watcher, so a newer user generation would have replaced it with working.
  if (stateStartedAt == null || lifecycle.timestamp == null) {
    return true
  }
  if (lifecycle.timestamp >= stateStartedAt) {
    return true
  }
  // Why: transcript clocks and hook receipt times can skew over SSH/runtime.
  // Only apply slack to real epoch timestamps so small logical clocks used in
  // tests (and any non-wall-clock ids) keep strict ordering.
  if (lifecycle.timestamp > 1e11 && stateStartedAt > 1e11) {
    return lifecycle.timestamp + LIFECYCLE_CLOCK_SKEW_SLACK_MS >= stateStartedAt
  }
  return false
}

function trailingAssistantPostDates(
  sources: NativeChatSources,
  stateStartedAt: number | null | undefined
): boolean {
  if (stateStartedAt == null) {
    return false
  }
  const last = (sources.transcript ?? []).at(-1)
  return last?.role === 'assistant' && last.timestamp != null && last.timestamp >= stateStartedAt
}
