import { statSync } from 'node:fs'
import type { AgentHookSource } from './transport/agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { hasCodexTranscriptSubagents } from './providers/codex-state'
import { hasMuseSessionLog } from './providers/muse-events'
import { hasPendingCodexSubagentIdentity } from '../codex-subagent-roster'
import { isSameAgentProcess } from '../agent-status/process/agent-process-presence'
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
  if (source === 'muse') {
    // Muse question waits/answers exist only in the session log.
    return event.payload.state !== 'done' && hasMuseSessionLog(state, event.paneKey)
  }
  return false
}

// A quiet Muse log backs off while periodic presence checks can prove its owner exited.
const MUSE_IDLE_PROBE_MS = 60_000
const MUSE_POLL_MAX_DELAY_MS = 30_000

export type TranscriptPollIdle = { mark?: string; delay: number; probedAt: number }

export function advanceTranscriptPollIdle(
  source: AgentHookSource,
  mark: string | undefined,
  idle: TranscriptPollIdle | undefined,
  now: number
): { idle?: TranscriptPollIdle; action: 'poll' | 'probe' } {
  if (source !== 'muse') {
    return { action: 'poll' }
  }
  if (!idle || idle.mark !== mark) {
    return { idle: { mark, delay: 1_000, probedAt: now }, action: 'poll' }
  }
  idle = { ...idle, delay: Math.min(idle.delay * 2, MUSE_POLL_MAX_DELAY_MS) }
  if (now - idle.probedAt >= MUSE_IDLE_PROBE_MS) {
    return { idle: { ...idle, probedAt: now }, action: 'probe' }
  }
  return { idle, action: 'poll' }
}

export function museTranscriptStamp(state: HookListenerState, paneKey: string): string | undefined {
  const cursor = state.musePaneStateByPaneKey.get(paneKey)?.log?.cursor
  const path = cursor?.filePath
  if (!path) {
    return undefined
  }
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size === cursor.offset
      ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      : undefined
  } catch {
    return undefined
  }
}

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

/** A probe can restate a live row (e.g. suspension flip) with no hook to re-arm its poll; returns that row. */
export function presenceRestatedPollRow<T extends AgentHookEventPayload>(
  state: HookListenerState,
  polled: T,
  pending: { original: AgentHookEventPayload } | undefined
): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers store rows of their own enriched type.
  const row = state.lastStatusByPaneKey.get(polled.paneKey) as T | undefined
  // A pending poll for any other row was re-armed by a newer hook.
  if (!row || row === polled || (pending && pending.original !== polled)) {
    return undefined
  }
  const owner = row.agentPresence
  const prior = polled.agentPresence?.process
  const sameOwner = !owner?.process || !prior || isSameAgentProcess(owner.process, prior)
  return !owner?.ended &&
    sameOwner &&
    row.payload.agentType === polled.payload.agentType &&
    row.payload.state === polled.payload.state &&
    row.providerSession?.id === polled.providerSession?.id
    ? row
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
