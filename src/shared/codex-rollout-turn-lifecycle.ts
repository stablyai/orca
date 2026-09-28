// Codex's own record of a turn's lifecycle in its rollout. Both the native-chat transcript
// decoders and the hook lane's rollout reconcile read it, so they cannot disagree about which
// line starts, completes or aborts a turn.
import type { NativeChatTurnLifecycleState } from './native-chat-types'
import { record, type JsonRecord } from './codex-rollout-jsonl-cursor'

/** Codex `event_msg` payload types that bound a turn's lifecycle. */
export const CODEX_EVENT_TURN_STARTED = 'task_started'
export const CODEX_EVENT_TURN_COMPLETE = 'task_complete'
export const CODEX_EVENT_TURN_ABORTED = 'turn_aborted'

// Why: a hook trails its turn's rollout markers by at most a turn or two; this bounds memory on a
// long session while still recognising any hook that plausibly arrives late.
const CODEX_ENDED_TURNS_MAX = 32

export type CodexRolloutTurnLifecycle = {
  state: NativeChatTurnLifecycleState
  /** The turn's `turn_id`, the same id Codex puts on that turn's hooks. */
  turnId?: string
}

/** How Codex's rollout recorded a turn's end. Codex reports every `turn_aborted`, whatever its
 *  `TurnAbortReason`, as an interrupted turn, so no reason is kept. */
export type CodexRolloutTurnEnd = Exclude<NativeChatTurnLifecycleState, 'working'>

/** The main agent's turns as its rollout recorded them: the one Codex has open, the latest one it
 *  started (open or not; or ended, when the read began after its start), and a bounded window of
 *  ended ones (oldest first). */
export type CodexRolloutTurns = {
  openTurnId?: string
  latestTurnId?: string
  ended: Map<string, CodexRolloutTurnEnd>
}

export function decodeCodexRolloutTurnLifecycle(
  recordValue: JsonRecord
): CodexRolloutTurnLifecycle | undefined {
  const payload = record(recordValue.payload)
  if (recordValue.type !== 'event_msg' || !payload) {
    return undefined
  }
  const state =
    payload.type === CODEX_EVENT_TURN_STARTED
      ? 'working'
      : payload.type === CODEX_EVENT_TURN_COMPLETE
        ? 'completed'
        : payload.type === CODEX_EVENT_TURN_ABORTED
          ? 'interrupted'
          : undefined
  if (!state) {
    return undefined
  }
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id.trim() : ''
  return { state, ...(turnId ? { turnId } : {}) }
}

export function createCodexRolloutTurns(): CodexRolloutTurns {
  return { ended: new Map() }
}

export function recordCodexRolloutTurn(
  turns: CodexRolloutTurns,
  lifecycle: CodexRolloutTurnLifecycle
): void {
  if (lifecycle.state === 'working') {
    turns.openTurnId = lifecycle.turnId
    turns.latestTurnId = lifecycle.turnId
    return
  }
  // Why: `turn_aborted.turn_id` is optional in Codex; an end without one ends the open turn.
  const turnId = lifecycle.turnId ?? turns.openTurnId
  if (turnId === undefined) {
    return
  }
  if (turns.openTurnId === turnId) {
    turns.openTurnId = undefined
  }
  // Why: a first read begins at most one read back, so a long turn's start can precede it.
  turns.latestTurnId ??= turnId
  turns.ended.delete(turnId)
  turns.ended.set(turnId, lifecycle.state)
  if (turns.ended.size > CODEX_ENDED_TURNS_MAX) {
    const oldest = turns.ended.keys().next().value
    if (oldest !== undefined) {
      turns.ended.delete(oldest)
    }
  }
}
