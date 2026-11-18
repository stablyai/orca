import { basename } from 'node:path'
import type { AgentHookSource } from './transport/agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { hasMuseSessionLog } from './providers/muse/muse-events'
import { parseHookEnvelope } from './hook-envelope'
import { codexChildRolloutPath } from './providers/codex/codex-subagent-roster'

export function shouldPollHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  if (source === 'codex') {
    return codexRolloutTailPath(state, event.paneKey) !== undefined
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

/** Log growth, a status change, or any hook for the session restores the 1s cadence. */
export function nextMusePollDelay(previousMs?: number, quiet = false): number {
  return quiet ? Math.min((previousMs ?? MUSE_POLL_MS) * 2, MUSE_QUIET_POLL_MAX_MS) : MUSE_POLL_MS
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

/** Codex's rollouts are tailed only while a root turn is open with no Stop or Interrupt yet (/review
 *  and failed turns end without either) or a child is live (an errored, interrupted or aborted child
 *  sends no SubagentStop); only the rollouts record those ends. */
export function codexRolloutTailPath(
  state: HookListenerState,
  paneKey: string
): string | undefined {
  const root = state.codexRolloutByPaneKey.get(paneKey)?.root?.cursor.filePath
  if (root && state.codexLeadStateByPaneKey.get(paneKey)?.state !== 'done') {
    return root
  }
  const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
  const child = [...(roster?.values() ?? [])]
    .map((tracked) => codexChildRolloutPath(tracked, root))
    .find(Boolean)
  return child ? (root ?? child) : undefined
}

/** The tail's directory watch wakes for the root rollout and its live children's rollouts. */
export function codexRolloutWatchesName(
  state: HookListenerState,
  paneKey: string,
  name: string
): boolean {
  const root = state.codexRolloutByPaneKey.get(paneKey)?.root?.cursor.filePath
  if (root && basename(root) === name) {
    return true
  }
  for (const child of state.codexSubagentRosterByPaneKey.get(paneKey)?.values() ?? []) {
    if (child.rolloutPath && basename(child.rolloutPath) === name) {
      return true
    }
  }
  return false
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
