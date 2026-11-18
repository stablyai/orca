import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { record } from './codex-rollout-jsonl-format'
import { buildCodexChildDrivenStatusPayload } from './codex-events'
import { markCodexLeadTurnInterrupted, setCodexMainAgentTurnState } from './codex-state'
import { pendingCodexAsyncQuestion } from './codex-async-questions'
import { finishCodexSubagent } from './codex-subagent-roster'
import { codexCancelNeedsRollout } from './codex-interrupt-hook-support'
import type { CodexApprovalsReviewer } from './codex-subagent-reviewer'
import {
  codexRolloutFile,
  codexTranscriptTurnEnd,
  codexTurnReviewer,
  forgetCodexChildRollout,
  CODEX_CHILD_ABORT_SETTLE_MS,
  type CodexApprovalHold,
  type CodexRolloutState
} from './codex-rollout-state'

/** Past this a held approval shows a fallback state, so a hung read cannot hide a prompt. */
const CODEX_APPROVAL_HOLD_MAX_MS = 5_000

/**
 * The reviewer that settles a hold, or undefined while its read may still land in time. Only a read
 * that started after the request, or this turn's own read, may keep an approval working: a reviewer
 * cached from an earlier turn must never hide a prompt. An overdue hold stays open so its late read
 * still corrects the fallback.
 */
function holdReviewer(
  rollout: CodexRolloutState,
  hold: CodexApprovalHold,
  now: number
): { reviewer: CodexApprovalsReviewer | undefined; final: boolean } | undefined {
  const file = codexRolloutFile(rollout, hold.filePath)
  if (!file || file.resolved >= hold.seq) {
    return { reviewer: file?.reviewer, final: true }
  }
  if (hold.overdue || now - hold.heldAt < CODEX_APPROVAL_HOLD_MAX_MS) {
    return undefined
  }
  hold.overdue = true
  return { reviewer: codexTurnReviewer(rollout, hold.filePath), final: false }
}

/** When a child's abort may be settled by a later read (a replaced turn restarts before then). */
export function codexChildAbortDeadline(
  state: HookListenerState,
  paneKey: string
): number | undefined {
  let deadline: number | undefined
  const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
  for (const [id, end] of state.codexRolloutByPaneKey.get(paneKey)?.childEnds ?? []) {
    if (!end.settled && roster?.get(id)?.hooks === end.hooks) {
      const due = end.at + CODEX_CHILD_ABORT_SETTLE_MS
      deadline = deadline === undefined ? due : Math.min(deadline, due)
    }
  }
  return deadline
}

/** When the oldest approval hold still waiting on its read must fall back. */
export function codexApprovalHoldDeadline(
  state: HookListenerState,
  paneKey: string
): number | undefined {
  const holds = [
    state.codexRolloutByPaneKey.get(paneKey)?.rootApprovalHold,
    ...Array.from(
      state.codexSubagentRosterByPaneKey.get(paneKey)?.values() ?? [],
      (child) => child.approvalHold
    )
  ]
  let deadline: number | undefined
  for (const hold of holds) {
    if (hold && !hold.overdue) {
      const due = hold.heldAt + CODEX_APPROVAL_HOLD_MAX_MS
      deadline = deadline === undefined ? due : Math.min(deadline, due)
    }
  }
  return deadline
}

/** Settle approvals whose reviewer read finished, or show a fallback once it is overdue. */
function settleCodexApprovalHolds(state: HookListenerState, paneKey: string, now: number): void {
  const rollout = state.codexRolloutByPaneKey.get(paneKey)
  if (!rollout) {
    return
  }
  const rootHold = rollout.rootApprovalHold
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  // Ordering rule: the turn moving on answered the approval; its own PostToolUse clears it on arrival.
  if (rootHold && rollout.epoch !== rootHold.epoch) {
    rollout.rootApprovalHold = undefined
  } else if (rootHold) {
    const settled = holdReviewer(rollout, rootHold, now)
    if (settled) {
      if (settled.final) {
        rollout.rootApprovalHold = undefined
      }
      const next =
        settled.reviewer !== 'auto_review' || pendingCodexAsyncQuestion(state, paneKey)
          ? 'waiting'
          : 'working'
      // Ordering rule: a verdict that matches what was shown changes nothing, so a parallel
      // tool's hook in between is not overridden twice; a new verdict applies even after one.
      if (next !== rootHold.shown) {
        rootHold.shown = next
        if (next !== lead?.state) {
          setCodexMainAgentTurnState(state, paneKey, { state: next, model: rootHold.model })
        }
      }
    }
  }
  for (const child of state.codexSubagentRosterByPaneKey.get(paneKey)?.values() ?? []) {
    const hold = child.approvalHold
    const settled = hold && holdReviewer(rollout, hold, now)
    if (!settled) {
      continue
    }
    if (settled.final) {
      child.approvalHold = undefined
    }
    const next = settled.reviewer === 'auto_review' ? 'working' : 'waiting'
    if (next !== hold.shown) {
      hold.shown = next
      child.state = next
    }
  }
}

// A child whose rollout stays unreadable and who sends no hooks this long is gone (deleted or never written).
const CHILD_UNREADABLE_GRACE_MS = 60_000

/** Retire children whose own rollout ended their turn without a SubagentStop (an errored turn, or
 *  one stopped by interrupt_agent or aborted at session end), or who left neither a rollout nor hooks. */
function retireEndedCodexChildren(state: HookListenerState, paneKey: string, now: number): void {
  const rollout = state.codexRolloutByPaneKey.get(paneKey)
  const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
  if (!rollout || !roster) {
    return
  }
  for (const [id, child] of roster) {
    const file = child.rolloutPath ? rollout.childFiles.get(child.rolloutPath) : undefined
    const end = rollout.childEnds.get(id)
    const ended = end?.hooks === child.hooks && end.settled
    const vanished =
      file?.unreadableSince !== undefined &&
      now - file.unreadableSince >= CHILD_UNREADABLE_GRACE_MS &&
      now - (child.lastHookAt ?? 0) >= CHILD_UNREADABLE_GRACE_MS
    if (ended || vanished) {
      finishCodexSubagent(roster, id)
      forgetCodexChildRollout(rollout, id)
    }
  }
}

/** The row rollout facts imply for the current hook row, without I/O: a replayed Stop for an
 *  ended turn (/review, failed turn), a pre-0.150 cancel, or a restatement of names/approvals. */
export function codexRolloutStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  body: unknown,
  env: string,
  now = Date.now()
): AgentHookEventPayload | undefined {
  settleCodexApprovalHolds(state, original.paneKey, now)
  retireEndedCodexChildren(state, original.paneKey, now)
  const rollout = state.codexRolloutByPaneKey.get(original.paneKey)
  const lead = state.codexLeadStateByPaneKey.get(original.paneKey)
  const rootTurn = rollout?.rootTurn
  const interrupted =
    rootTurn?.interrupted === true &&
    lead !== undefined &&
    lead.state !== 'done' &&
    // A turn_aborted for an earlier turn must not cancel the one the hooks opened since.
    (!rootTurn.turnId || !lead.turnId || rootTurn.turnId === lead.turnId) &&
    codexCancelNeedsRollout(rollout)
  const envelope = record(body)
  if (
    !interrupted &&
    envelope &&
    rollout?.root &&
    lead?.turnId &&
    lead.state !== 'done' &&
    codexTranscriptTurnEnd(rollout, lead.turnId)
  ) {
    const stop = {
      ...envelope,
      hook_event_name: undefined,
      hookEventName: undefined,
      payload: {
        hook_event_name: 'Stop',
        ...(lead.sessionId ? { session_id: lead.sessionId } : {}),
        turn_id: lead.turnId,
        transcript_path: rollout.root.cursor.filePath
      }
    }
    return normalizeHookPayload(state, 'codex', stop, env) ?? undefined
  }
  if (interrupted) {
    markCodexLeadTurnInterrupted(state, original.paneKey)
  }
  const payload = buildCodexChildDrivenStatusPayload(state, undefined, original.paneKey, {})
  // Why: only a replayed Stop may carry an event name; this row restates the last hook's.
  return payload ? { ...original, hookEventName: undefined, payload } : undefined
}
