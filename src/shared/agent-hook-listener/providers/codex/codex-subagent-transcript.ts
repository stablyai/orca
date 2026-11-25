import { readJsonlCursor, readTranscriptDirectory } from './codex-rollout-jsonl-cursor'
import { record, type JsonlCursor, type JsonRecord } from './codex-rollout-jsonl-format'
import {
  markParentReadDeferred,
  rolloutCursorReadDeferred,
  rolloutReadsPrefetched
} from './codex-rollout-prefetch-scope'

import {
  childTurnState,
  readChildModel,
  readTurnEnd,
  reconcileCodexTranscriptTurn,
  type CodexTranscriptTurn
} from './codex-turn-transcript'
import {
  normalizedTranscriptPath,
  resolveChildTranscript,
  SAFE_THREAD_ID
} from './codex-rollout-paths'

import { isCodexStatusTranscriptLine } from './codex-status-transcript-line'

import { readApprovalsReviewer } from './codex-subagent-reviewer'
import type { CodexApprovalsReviewer } from './codex-subagent-reviewer'

import { codexSubagentPathLabel } from './codex-agent-path'
import {
  keepCodexSubagentHidden,
  takeInterruptedCodexSubagent
} from './codex-interrupted-subagents'
import {
  finishCodexSubagent,
  queueCodexSubagentIdentity,
  setCodexSubagentModel,
  upsertCodexSubagent,
  type CodexSubagentRoster
} from './codex-subagent-roster'

// Why: retire a child whose rollout stays unreadable this long, else a deleted/never-written file pins a phantom row forever.
const CHILD_UNREADABLE_GRACE_MS = 60_000
const MAX_TRACKED_TURN_ENDS = 16

export type TrackedTranscriptSubagent = JsonlCursor & {
  description?: string
  /** Retain the child’s own model across incremental reads; turn_context appears once per turn. */
  model?: string
  startedAt: number
  unresolvedSince?: number
  /** Re-messaged after an interrupt: its interrupted turn ends it, since send_message starts no new turn. */
  interrupted?: true
  /** When a resumed child's turn ended; for a grace it is still read, unshown, so a new turn shows it again. */
  hiddenSince?: number
}

export type CodexSubagentTranscriptState = {
  parent: JsonlCursor
  rootTurn: CodexTranscriptTurn
  turnEnds: Map<string, 'completed' | 'failed'>
  subagents: Map<string, TrackedTranscriptSubagent>
  /** Children retired by an interrupt, kept so a later message can show them working again. */
  interruptedSubagents: Map<string, TrackedTranscriptSubagent>
  /** Incremental reviewer cursors for child rollouts, which must not replace the parent cursor. */
  reviewerCursorsByPath: Map<string, JsonlCursor>
  /** Reviewer ownership discovered from child rollouts, keyed by their bounded cursor paths. */
  reviewersByPath: Map<string, CodexApprovalsReviewer>
  /** Who resolves this turn's approvals in the parent rollout. */
  approvalsReviewer?: CodexApprovalsReviewer
}

function readActivity(recordValue: JsonRecord):
  | {
      id: string
      description?: string
      kind: 'started' | 'interacted' | 'interrupted'
      startedAt: number
      fromItem: boolean
    }
  | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  // Paginated-history rollouts persist activity only as items.
  const item = payload?.type === 'item_completed' ? record(payload.item) : undefined
  const activity =
    payload?.type === 'sub_agent_activity'
      ? payload
      : item?.type === 'SubAgentActivity'
        ? item
        : undefined
  if (!activity) {
    return undefined
  }
  const id = typeof activity.agent_thread_id === 'string' ? activity.agent_thread_id.trim() : ''
  const rawKind = typeof activity.kind === 'string' ? activity.kind.toLowerCase() : ''
  if (
    !SAFE_THREAD_ID.test(id) ||
    (rawKind !== 'started' && rawKind !== 'interacted' && rawKind !== 'interrupted')
  ) {
    return undefined
  }
  return {
    id,
    description:
      codexSubagentPathLabel(
        typeof activity.agent_path === 'string' ? activity.agent_path : null
      ) ?? undefined,
    kind: rawKind,
    startedAt:
      typeof activity.occurred_at_ms === 'number' && Number.isFinite(activity.occurred_at_ms)
        ? activity.occurred_at_ms
        : Date.now(),
    fromItem: activity === item
  }
}

export function createCodexSubagentTranscriptState(): CodexSubagentTranscriptState {
  return {
    parent: { offset: 0, carry: '' },
    rootTurn: { interrupted: false },
    turnEnds: new Map(),
    subagents: new Map(),
    interruptedSubagents: new Map(),
    reviewerCursorsByPath: new Map(),
    reviewersByPath: new Map()
  }
}

export function codexTranscriptTurnEnd(
  state: CodexSubagentTranscriptState | undefined,
  turnId: string
): 'completed' | 'failed' | undefined {
  return state?.turnEnds.get(turnId)
}

export function hasTrackedCodexTranscriptSubagents(
  state: CodexSubagentTranscriptState | undefined
): boolean {
  // Hidden children only ride along on reads that happen anyway; they never keep the poll alive.
  for (const child of state?.subagents.values() ?? []) {
    if (child.hiddenSince === undefined) {
      return true
    }
  }
  return false
}

/** Resets per-session state when the parent rollout changes; undefined for an unusable path. */
function beginCodexTranscriptReconcile(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  transcriptPath: string | undefined
): { path: string; changed: boolean } | undefined {
  const normalizedPath = normalizedTranscriptPath(transcriptPath)
  if (!normalizedPath) {
    return undefined
  }
  if (state.parent.filePath === normalizedPath) {
    return { path: normalizedPath, changed: false }
  }
  for (const id of state.subagents.keys()) {
    finishCodexSubagent(roster, id)
  }
  state.parent = { filePath: normalizedPath, offset: 0, carry: '' }
  state.rootTurn = { interrupted: false }
  state.turnEnds.clear()
  state.subagents.clear()
  state.interruptedSubagents.clear()
  state.reviewerCursorsByPath.clear()
  state.reviewersByPath.clear()
  // Why: a different rollout is a different session, so its predecessor's reviewer is void.
  state.approvalsReviewer = undefined
  return { path: normalizedPath, changed: true }
}

export function applyCodexParentTranscript(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  parentRecords: JsonRecord[] | undefined
): boolean {
  const changed =
    Boolean(parentRecords?.length) ||
    (parentRecords === undefined && state.approvalsReviewer !== undefined)
  reconcileCodexTranscriptTurn(state.rootTurn, parentRecords ?? [])
  // A stale reviewer must never turn an unreadable rollout into a hidden prompt.
  state.approvalsReviewer =
    parentRecords === undefined
      ? undefined
      : (readApprovalsReviewer(parentRecords) ?? state.approvalsReviewer)
  // Hook-only and restored children may predate the bounded parent transcript read.
  for (const [id, child] of roster) {
    if (!state.subagents.has(id)) {
      state.subagents.set(id, { offset: 0, carry: '', startedAt: child.startedAt })
    }
  }
  for (const recordValue of parentRecords ?? []) {
    const turnEnd = readTurnEnd(recordValue)
    if (turnEnd) {
      state.turnEnds.delete(turnEnd.turnId)
      state.turnEnds.set(turnEnd.turnId, turnEnd.end)
      const oldest = state.turnEnds.keys().next()
      if (state.turnEnds.size > MAX_TRACKED_TURN_ENDS && !oldest.done) {
        state.turnEnds.delete(oldest.value)
      }
      continue
    }
    const activity = readActivity(recordValue)
    if (!activity) {
      continue
    }
    const tracked = state.subagents.get(activity.id)
    if (activity.kind === 'interrupted') {
      finishCodexSubagent(roster, activity.id)
      state.subagents.delete(activity.id)
      if (tracked) {
        state.interruptedSubagents.set(activity.id, tracked)
      }
      continue
    }
    const resumed = takeInterruptedCodexSubagent(state, activity.id, activity.startedAt)
    // Why: hooks already announce children, and a resume's bounded reread must not re-add finished
    // ones, so items only re-add a child this session saw interrupted.
    if (activity.fromItem && !resumed) {
      continue
    }
    const next: TrackedTranscriptSubagent = resumed ??
      tracked ?? { offset: 0, carry: '', startedAt: activity.startedAt }
    next.description = activity.description ?? next.description
    state.subagents.set(activity.id, next)
    upsertCodexSubagent(
      roster,
      activity.id,
      { description: next.description, state: 'working' },
      next.startedAt
    )
  }
  return changed
}

/** `deferred` skips a child whose rollout was not read this pass. */
type ChildTranscriptReader = (
  id: string,
  tracked: TrackedTranscriptSubagent
) => JsonRecord[] | undefined | 'deferred'

export function applyCodexChildTranscripts(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  readChild: ChildTranscriptReader
): boolean {
  let changed = false
  const now = Date.now()
  for (const [id, tracked] of state.subagents) {
    const records = readChild(id, tracked)
    if (
      records === 'deferred' ||
      keepCodexSubagentHidden(state, roster, id, tracked, records, now)
    ) {
      continue
    }
    changed ||= Boolean(records?.length)
    if (!records) {
      // Why: a rollout that never appears (or is deleted) has no completion event, so time-box it instead of leaking a working row.
      tracked.filePath = undefined
      tracked.unresolvedSince ??= now
      if (now - tracked.unresolvedSince <= CHILD_UNREADABLE_GRACE_MS) {
        continue
      }
    } else {
      tracked.unresolvedSince = undefined
      // A missed or early hook read must not leave the child unnamed; the poll's bounded retries read it.
      if (tracked.filePath) {
        queueCodexSubagentIdentity(roster, id, tracked.filePath)
      }
      tracked.model = readChildModel(records) ?? tracked.model
      // Reapply each poll because parent activity can rebuild the child row and erase its discovered model.
      setCodexSubagentModel(roster, id, tracked.model)
      if (childTurnState(records, tracked.interrupted) !== 'ended') {
        continue
      }
    }
    changed = true
    finishCodexSubagent(roster, id)
    if (records && tracked.interrupted) {
      tracked.hiddenSince = now
      continue
    }
    state.subagents.delete(id)
    if (tracked.interrupted) {
      state.interruptedSubagents.set(id, tracked)
    }
  }
  return changed
}

export function reconcileCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  transcriptPath: string | undefined
): boolean {
  const begun = beginCodexTranscriptReconcile(state, roster, transcriptPath)
  if (!begun) {
    return false
  }
  let changed = begun.changed
  if (rolloutCursorReadDeferred(state.parent)) {
    markParentReadDeferred()
  } else {
    const parentRecords = readJsonlCursor(state.parent, isCodexStatusTranscriptLine)
    changed = applyCodexParentTranscript(state, roster, parentRecords) || changed
  }
  const entriesByDirectory = new Map<string, string[]>()
  const entriesFor = (directory: string): string[] => {
    let entries = entriesByDirectory.get(directory)
    if (!entries) {
      entries = readTranscriptDirectory(directory)
      entriesByDirectory.set(directory, entries)
    }
    return entries
  }
  changed =
    applyCodexChildTranscripts(state, roster, (id, tracked) => {
      if (!tracked.filePath && rolloutReadsPrefetched()) {
        return 'deferred'
      }
      tracked.filePath ??= resolveChildTranscript(begun.path, id, tracked.startedAt, entriesFor)
      return rolloutCursorReadDeferred(tracked)
        ? 'deferred'
        : readJsonlCursor(tracked, isCodexStatusTranscriptLine)
    }) || changed
  return changed
}
