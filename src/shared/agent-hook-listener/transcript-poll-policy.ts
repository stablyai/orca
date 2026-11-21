import { agentSubagentsEqual } from '../agent-status/contracts/agent-status-subagent-snapshot'
import { AGENT_STATUS_STALE_AFTER_MS } from '../agent-status/contracts/agent-status-freshness'
import type { AgentHookSource } from './transport/agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import type { AgentTranscriptPollScheduler } from './transcripts/agent-transcript-poll-scheduler'
import {
  hasAntigravityPollWork,
  antigravityDiscoveryEndsAt,
  antigravityIdleGraceEndsAt,
  isAntigravityPollSettled
} from './providers/antigravity/antigravity-transcript-poll'
import { hasCodexTranscriptSubagents } from './providers/codex/codex-state'
import { hasMuseSessionLog } from './providers/muse/muse-events'
import { hasPendingCodexSubagentIdentity } from './providers/codex/codex-subagent-roster'
import { parseHookEnvelope } from './hook-envelope'

export function shouldPollHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  if (source === 'codex') {
    return (
      hasCodexTranscriptSubagents(state, event.paneKey) ||
      hasPendingCodexSubagentIdentity(state.codexSubagentRosterByPaneKey.get(event.paneKey)) ||
      (state.codexLeadStateByPaneKey.get(event.paneKey)?.state !== 'done' &&
        Boolean(state.codexSubagentTranscriptByPaneKey.get(event.paneKey)?.parent.filePath))
    )
  }
  if (source === 'antigravity') {
    return hasAntigravityPollWork(state, event)
  }
  if (source === 'muse') {
    // Muse question waits/answers exist only in the session log.
    return event.payload.state !== 'done' && hasMuseSessionLog(state, event.paneKey)
  }
  return false
}

const MUSE_POLL_MS = 1_000
// Why: a Muse session killed before Stop leaves a log nobody writes. Silence cannot prove exit (a
// live quiet session may still log a question), so back off to one stat per 5s instead of stopping.
const MUSE_QUIET_POLL_MAX_MS = 5_000

// Why: a settled agy pane can only change by a KILLED descriptor, which no hook announces.
const ANTIGRAVITY_SETTLED_QUIET_POLL_MAX_MS = 30_000

/** Log growth, a status change, or any hook for the session restores the 1s cadence. */
export function nextMusePollDelay(
  previousMs?: number,
  quiet = false,
  maxMs = MUSE_QUIET_POLL_MAX_MS
): number {
  return quiet ? Math.min((previousMs ?? MUSE_POLL_MS) * 2, maxMs) : MUSE_POLL_MS
}

export function nextHookTranscriptPollDelay(
  state: HookListenerState,
  { source, delayMs: previousMs }: { source: AgentHookSource; delayMs?: number },
  paneKey: string,
  quiet: boolean,
  nextPoll?: 'backlog' | 'unchanged'
): number | undefined {
  if (source !== 'muse' && source !== 'antigravity') {
    return undefined
  }
  if (nextPoll === 'backlog') {
    return MUSE_POLL_MS
  }
  if (nextPoll === 'unchanged') {
    return ANTIGRAVITY_SETTLED_QUIET_POLL_MAX_MS
  }
  const pane =
    source === 'antigravity' ? state.antigravityChildWorkByPaneKey.get(paneKey) : undefined
  if (pane && pane.verifiedChildren.size === 0) {
    const deadline = antigravityIdleGraceEndsAt(pane) ?? antigravityDiscoveryEndsAt(pane)
    return Math.min(
      nextMusePollDelay(previousMs, quiet, AGENT_STATUS_STALE_AFTER_MS),
      Math.max(1, deadline - Date.now())
    )
  }
  const settled = source === 'antigravity' && isAntigravityPollSettled(state, paneKey)
  return nextMusePollDelay(
    previousMs,
    quiet,
    settled ? ANTIGRAVITY_SETTLED_QUIET_POLL_MAX_MS : MUSE_QUIET_POLL_MAX_MS
  )
}

export function museLogOffset(state: HookListenerState, paneKey: string): number | undefined {
  return state.musePaneStateByPaneKey.get(paneKey)?.log?.cursor.offset
}

/** The pane of an ignored hook (e.g. PermissionRequest) from the active Muse session, whose poll it re-arms. */
export function museHookPollPane(
  state: HookListenerState,
  body: unknown,
  env: string
): string | undefined {
  const hook = parseHookEnvelope(state, 'muse', body, env)
  if (!hook) {
    return undefined
  }
  const row = state.lastStatusByPaneKey.get(hook.paneKey)
  const session = hook.hookPayloadRecord.session_id
  return row?.payload.agentType === 'muse' &&
    row.payload.state !== 'done' &&
    row.worktreeId === hook.worktreeId &&
    typeof session === 'string' &&
    session === row.providerSession?.id
    ? hook.paneKey
    : undefined
}

/** Child rollout discovery keeps its existing cadence; only a root-only pane can use one file watch. */
export function hookTranscriptWatchPath(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string
): string | undefined {
  return source === 'codex' && !hasCodexTranscriptSubagents(state, paneKey)
    ? state.codexSubagentTranscriptByPaneKey.get(paneKey)?.parent.filePath
    : undefined
}

export function scheduleHookTranscriptPoll<
  T extends { source: AgentHookSource; original: AgentHookEventPayload; delayMs?: number }
>(scheduler: AgentTranscriptPollScheduler<T>, state: HookListenerState, poll: T): void {
  const { source, original } = poll
  // Nested CLIs inherit pane keys; an unrelated provider must leave the existing poll alone.
  if (source !== 'codex' && source !== 'muse' && source !== 'antigravity') {
    return
  }
  const { paneKey } = original
  if (!shouldPollHookTranscript(state, source, original)) {
    scheduler.clear(paneKey)
    return
  }
  const delayMs = source === 'codex' ? undefined : (poll.delayMs ?? nextMusePollDelay())
  const owner =
    source === 'antigravity'
      ? state.antigravityChildWorkByPaneKey.get(paneKey)?.brainCache
      : undefined
  scheduler.schedule(
    paneKey,
    { ...poll, delayMs },
    hookTranscriptWatchPath(state, source, paneKey),
    delayMs,
    owner ?? source
  )
}

export function transcriptPollUpdate<T extends AgentHookEventPayload>(
  source: AgentHookSource,
  original: T,
  polled: T
): T | undefined {
  if (original === polled) {
    return undefined
  }
  if (source === 'muse') {
    const changed =
      polled.payload.state !== original.payload.state ||
      polled.payload.interactivePrompt !== original.payload.interactivePrompt
    // Replayed prompt bodies cannot create new prompt or turn boundaries.
    return changed
      ? { ...polled, hasExplicitPrompt: undefined, hookEventName: undefined }
      : undefined
  }
  if (source === 'antigravity') {
    const subagentsChanged = !agentSubagentsEqual(
      polled.payload.subagents,
      original.payload.subagents
    )
    const changed =
      subagentsChanged ||
      polled.payload.state !== original.payload.state ||
      polled.payload.workingMode !== original.payload.workingMode ||
      polled.payload.model !== original.payload.model ||
      polled.payload.mainAgent?.state !== original.payload.mainAgent?.state ||
      polled.payload.antigravitySpawnPending !== original.payload.antigravitySpawnPending ||
      polled.antigravityHelpersDrained !== original.antigravityHelpersDrained
    if (!changed) {
      return undefined
    }
    const completedTurn =
      polled.payload.state === 'done' &&
      original.payload.state !== 'done' &&
      polled.payload.mainAgent?.state === 'done'
    return {
      ...polled,
      hasExplicitPrompt: undefined,
      hookEventName: completedTurn ? 'Stop' : undefined
    }
  }
  const subagentsChanged =
    JSON.stringify(polled.payload.subagents) !== JSON.stringify(original.payload.subagents)
  const leadChanged =
    polled.payload.mainAgent?.state !== original.payload.mainAgent?.state ||
    polled.payload.mainAgent?.outcome !== original.payload.mainAgent?.outcome
  if (!subagentsChanged && !leadChanged) {
    return undefined
  }
  // Keep root Stop for remote turn-end derivation, but unlabel failures so clients cannot derive success.
  const replayedStop =
    polled.hookEventName === 'Stop' &&
    original.payload.mainAgent?.state !== 'done' &&
    polled.payload.mainAgent?.outcome !== 'failure'
  return {
    ...polled,
    hasExplicitPrompt: undefined,
    hookEventName: replayedStop ? 'Stop' : undefined
  }
}

export function antigravityHookPollRow(
  state: HookListenerState,
  body: unknown
): AgentHookEventPayload | undefined {
  const paneKey =
    typeof body === 'object' &&
    body !== null &&
    'paneKey' in body &&
    typeof body.paneKey === 'string'
      ? body.paneKey.trim()
      : undefined
  const row = paneKey ? state.lastStatusByPaneKey.get(paneKey) : undefined
  return row?.payload.agentType === 'antigravity' && hasAntigravityPollWork(state, row)
    ? row
    : undefined
}

export function ignoredHookTranscriptPoll<
  T extends { source: AgentHookSource; body: unknown; original: AgentHookEventPayload }
>(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string,
  peek: (paneKey: string) => T | undefined
): { source: AgentHookSource; body: unknown; original: AgentHookEventPayload } | T | undefined {
  if (source === 'antigravity') {
    const original = antigravityHookPollRow(state, body)
    return original ? { source, body, original } : undefined
  }
  const paneKey = museHookPollPane(state, body, env)
  const poll = paneKey ? peek(paneKey) : undefined
  return poll?.source === 'muse' &&
    state.lastStatusByPaneKey.get(poll.original.paneKey) === poll.original
    ? poll
    : undefined
}
