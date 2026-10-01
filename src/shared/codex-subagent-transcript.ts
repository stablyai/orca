import { basename, dirname, extname, isAbsolute, join } from 'node:path'

import {
  readJsonlCursor,
  readTranscriptDirectory,
  record,
  type JsonlCursor,
  type JsonRecord
} from './codex-rollout-jsonl-cursor'

import { readApprovalsReviewer } from './codex-subagent-reviewer'
import type { CodexApprovalsReviewer } from './codex-subagent-reviewer'

import {
  finishCodexSubagent,
  setCodexSubagentModel,
  upsertCodexSubagent,
  type CodexSubagentRoster
} from './codex-subagent-roster'

// Why: retire a child whose rollout stays unreadable this long, else a deleted/never-written file pins a phantom row forever.
const CHILD_UNREADABLE_GRACE_MS = 60_000
// Why: only the open turn is ever looked up; a small window covers a batch read after a restart.
const MAX_TRACKED_TURN_ENDS = 16
const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/

type TrackedTranscriptSubagent = JsonlCursor & {
  description?: string
  /** Latest model seen in the child's own rollout. Retained across polls
   *  because the cursor is incremental: `turn_context` is emitted once per
   *  turn, so a later read usually carries no model at all. */
  model?: string
  startedAt: number
  unresolvedSince?: number
}

/** How the root agent's turn ended, as its rollout recorded it. */
export type CodexTranscriptTurnEnd = 'completed' | 'failed'

export type CodexSubagentTranscriptState = {
  parent: JsonlCursor
  /** Root turn ends read from the parent rollout, keyed by Codex `turn_id`. */
  turnEnds: Map<string, CodexTranscriptTurnEnd>
  subagents: Map<string, TrackedTranscriptSubagent>
  /** Incremental reviewer cursors for child rollouts, which must not replace the parent cursor. */
  reviewerCursorsByPath: Map<string, JsonlCursor>
  /** Reviewer ownership discovered from child rollouts, keyed by their bounded cursor paths. */
  reviewersByPath: Map<string, CodexApprovalsReviewer>
  /** Who resolves this turn's approvals in the parent rollout. */
  approvalsReviewer?: CodexApprovalsReviewer
}

// Why: Codex files each rollout under its OWN local start date, so a session running past midnight spawns children into a sibling day directory.
function childDayDirectory(parentPath: string, startedAt: number): string | undefined {
  const dayDir = dirname(parentPath)
  const monthDir = dirname(dayDir)
  const yearDir = dirname(monthDir)
  if (
    !/^\d{2}$/.test(basename(dayDir)) ||
    !/^\d{2}$/.test(basename(monthDir)) ||
    !/^\d{4}$/.test(basename(yearDir)) ||
    !Number.isFinite(startedAt)
  ) {
    return undefined
  }
  const startedOn = new Date(startedAt)
  if (Number.isNaN(startedOn.getTime())) {
    return undefined
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return join(
    dirname(yearDir),
    String(startedOn.getFullYear()).padStart(4, '0'),
    pad(startedOn.getMonth() + 1),
    pad(startedOn.getDate())
  )
}

function resolveChildTranscript(
  parentPath: string,
  threadId: string,
  startedAt: number,
  entriesByDirectory: Map<string, string[]>
): string | undefined {
  if (!SAFE_THREAD_ID.test(threadId)) {
    return undefined
  }
  const suffix = `-${threadId}.jsonl`
  const parentDir = dirname(parentPath)
  const childDir = childDayDirectory(parentPath, startedAt)
  const directories = childDir && childDir !== parentDir ? [parentDir, childDir] : [parentDir]
  for (const directory of directories) {
    let entries = entriesByDirectory.get(directory)
    if (!entries) {
      entries = readTranscriptDirectory(directory)
      entriesByDirectory.set(directory, entries)
    }
    const fileName = entries.find((entry) => entry.endsWith(suffix))
    if (fileName) {
      return join(directory, fileName)
    }
  }
  return undefined
}

function readActivity(recordValue: JsonRecord):
  | {
      id: string
      description?: string
      kind: 'started' | 'interacted' | 'interrupted'
      startedAt: number
    }
  | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  if (payload?.type !== 'sub_agent_activity') {
    return undefined
  }
  const id = typeof payload.agent_thread_id === 'string' ? payload.agent_thread_id.trim() : ''
  const rawKind = typeof payload.kind === 'string' ? payload.kind.toLowerCase() : ''
  if (
    !SAFE_THREAD_ID.test(id) ||
    (rawKind !== 'started' && rawKind !== 'interacted' && rawKind !== 'interrupted')
  ) {
    return undefined
  }
  return {
    id,
    description:
      typeof payload.agent_path === 'string' ? payload.agent_path.trim() || undefined : undefined,
    kind: rawKind,
    startedAt:
      typeof payload.occurred_at_ms === 'number' && Number.isFinite(payload.occurred_at_ms)
        ? payload.occurred_at_ms
        : Date.now()
  }
}

/** Latest model from the child's own `turn_context` records. A child can be
 *  launched on a different model than its parent, so this is read from the
 *  child rollout rather than inherited. */
function readChildModel(records: JsonRecord[]): string | undefined {
  let model: string | undefined
  for (const recordValue of records) {
    if (recordValue.type !== 'turn_context') {
      continue
    }
    const payload = record(recordValue.payload)
    const value = typeof payload?.model === 'string' ? payload.model.trim() : ''
    if (value) {
      model = value
    }
  }
  return model
}

function readTurnEnd(
  recordValue: JsonRecord
): { turnId: string; end: CodexTranscriptTurnEnd } | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id.trim() : ''
  if (payload?.type !== 'task_complete' || !turnId) {
    return undefined
  }
  return { turnId, end: record(payload.error) ? 'failed' : 'completed' }
}

function normalizedTranscriptPath(transcriptPath: string | undefined): string | undefined {
  const normalizedPath = transcriptPath?.trim()
  return normalizedPath && isAbsolute(normalizedPath) && extname(normalizedPath) === '.jsonl'
    ? normalizedPath
    : undefined
}

function childIsComplete(records: JsonRecord[]): boolean {
  let complete = false
  for (const recordValue of records) {
    if (recordValue.type !== 'event_msg') {
      continue
    }
    const payload = record(recordValue.payload)
    if (payload?.type === 'task_started') {
      complete = false
    } else if (payload?.type === 'task_complete') {
      complete = true
    }
  }
  return complete
}

export function createCodexSubagentTranscriptState(): CodexSubagentTranscriptState {
  return {
    parent: { offset: 0, carry: '' },
    turnEnds: new Map(),
    subagents: new Map(),
    reviewerCursorsByPath: new Map(),
    reviewersByPath: new Map()
  }
}

export function hasTrackedCodexTranscriptSubagents(
  state: CodexSubagentTranscriptState | undefined
): boolean {
  return Boolean(state && state.subagents.size > 0)
}

export function codexTranscriptTurnEnd(
  state: CodexSubagentTranscriptState | undefined,
  turnId: string
): CodexTranscriptTurnEnd | undefined {
  return state?.turnEnds.get(turnId)
}

export function reconcileCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  transcriptPath: string | undefined
): void {
  const normalizedPath = normalizedTranscriptPath(transcriptPath)
  if (!normalizedPath) {
    return
  }
  if (state.parent.filePath !== normalizedPath) {
    for (const id of state.subagents.keys()) {
      finishCodexSubagent(roster, id)
    }
    state.parent = { filePath: normalizedPath, offset: 0, carry: '' }
    state.subagents.clear()
    state.turnEnds.clear()
    state.reviewerCursorsByPath.clear()
    state.reviewersByPath.clear()
    // Why: a different rollout is a different session, so its predecessor's reviewer is void.
    state.approvalsReviewer = undefined
  }
  const parentRecords = readJsonlCursor(state.parent)
  // A stale reviewer must never turn an unreadable rollout into a hidden prompt.
  state.approvalsReviewer =
    parentRecords === undefined
      ? undefined
      : (readApprovalsReviewer(parentRecords) ?? state.approvalsReviewer)
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
    if (activity.kind === 'interrupted') {
      finishCodexSubagent(roster, activity.id)
      state.subagents.delete(activity.id)
      continue
    }
    const tracked = state.subagents.get(activity.id) ?? {
      offset: 0,
      carry: '',
      startedAt: activity.startedAt
    }
    tracked.description = activity.description ?? tracked.description
    state.subagents.set(activity.id, tracked)
    upsertCodexSubagent(
      roster,
      activity.id,
      { description: tracked.description, state: 'working' },
      tracked.startedAt
    )
  }
  const entriesByDirectory = new Map<string, string[]>()
  const now = Date.now()
  for (const [id, tracked] of state.subagents) {
    if (!tracked.filePath) {
      tracked.filePath = resolveChildTranscript(
        normalizedPath,
        id,
        tracked.startedAt,
        entriesByDirectory
      )
    }
    const records = readJsonlCursor(tracked)
    if (!records) {
      // Why: a rollout that never appears (or is deleted) has no completion event, so time-box it instead of leaking a working row.
      tracked.filePath = undefined
      tracked.unresolvedSince ??= now
      if (now - tracked.unresolvedSince <= CHILD_UNREADABLE_GRACE_MS) {
        continue
      }
    } else {
      tracked.unresolvedSince = undefined
      tracked.model = readChildModel(records) ?? tracked.model
      // Why: re-applied every reconcile, not just on discovery — the parent's
      // own activity upsert can rebuild this child's roster entry, which would
      // otherwise drop a model found on an earlier poll.
      setCodexSubagentModel(roster, id, tracked.model)
      if (!childIsComplete(records)) {
        continue
      }
    }
    finishCodexSubagent(roster, id)
    state.subagents.delete(id)
  }
}
