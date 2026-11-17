import { basename, dirname, extname, isAbsolute, join } from 'node:path'

import {
  applyJsonlCursorBytes,
  readJsonlCursor,
  prefetchJsonlCursor,
  readJsonlCursorBytes,
  readTranscriptDirectory,
  readTranscriptDirectoryAsync,
  record,
  rolloutCursorReadDeferred,
  rolloutReadsPrefetched,
  type JsonlCursor,
  type PrefetchedRolloutReads,
  type JsonlCursorBytes,
  type JsonRecord
} from './codex-rollout-jsonl-cursor'

import { reconcileCodexTranscriptTurn, type CodexTranscriptTurn } from './codex-turn-transcript'

import { isCodexStatusTranscriptLine } from './codex-status-transcript-line'

import { readApprovalsReviewer } from './codex-subagent-reviewer'
import type { CodexApprovalsReviewer } from './codex-subagent-reviewer'

import { codexSubagentPathLabel } from './codex-agent-path'
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
const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/

type TrackedTranscriptSubagent = JsonlCursor & {
  description?: string
  /** Retain the child’s own model across incremental reads; turn_context appears once per turn. */
  model?: string
  startedAt: number
  unresolvedSince?: number
}

export type CodexSubagentTranscriptState = {
  parent: JsonlCursor
  rootTurn: CodexTranscriptTurn
  turnEnds: Map<string, 'completed' | 'failed'>
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

function childTranscriptDirectories(parentPath: string, startedAt: number): string[] {
  const parentDir = dirname(parentPath)
  const childDir = childDayDirectory(parentPath, startedAt)
  return childDir && childDir !== parentDir ? [parentDir, childDir] : [parentDir]
}

function resolveChildTranscript(
  parentPath: string,
  threadId: string,
  startedAt: number,
  entriesFor: (directory: string) => string[] | undefined
): string | undefined {
  if (!SAFE_THREAD_ID.test(threadId)) {
    return undefined
  }
  const suffix = `-${threadId}.jsonl`
  for (const directory of childTranscriptDirectories(parentPath, startedAt)) {
    const fileName = entriesFor(directory)?.find((entry) => entry.endsWith(suffix))
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
      codexSubagentPathLabel(typeof payload.agent_path === 'string' ? payload.agent_path : null) ??
      undefined,
    kind: rawKind,
    startedAt:
      typeof payload.occurred_at_ms === 'number' && Number.isFinite(payload.occurred_at_ms)
        ? payload.occurred_at_ms
        : Date.now()
  }
}

/** Read model from child turn_context; it may differ from the parent’s. */
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

export function normalizedTranscriptPath(transcriptPath: string | undefined): string | undefined {
  const normalizedPath = transcriptPath?.trim()
  return normalizedPath && isAbsolute(normalizedPath) && extname(normalizedPath) === '.jsonl'
    ? normalizedPath
    : undefined
}

function readTurnEnd(
  recordValue: JsonRecord
): { turnId: string; end: 'completed' | 'failed' } | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id.trim() : ''
  if ((payload?.type !== 'task_complete' && payload?.type !== 'turn_complete') || !turnId) {
    return undefined
  }
  return { turnId, end: payload.error == null ? 'completed' : 'failed' }
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
    rootTurn: { interrupted: false },
    turnEnds: new Map(),
    subagents: new Map(),
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
  return Boolean(state && state.subagents.size > 0)
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
  state.reviewerCursorsByPath.clear()
  state.reviewersByPath.clear()
  // Why: a different rollout is a different session, so its predecessor's reviewer is void.
  state.approvalsReviewer = undefined
  return { path: normalizedPath, changed: true }
}

function applyCodexParentTranscript(
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
  return changed
}

/** `deferred` skips a child whose rollout was not read this pass. */
type ChildTranscriptReader = (
  id: string,
  tracked: TrackedTranscriptSubagent
) => JsonRecord[] | undefined | 'deferred'

function applyCodexChildTranscripts(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  readChild: ChildTranscriptReader
): boolean {
  let changed = false
  const now = Date.now()
  for (const [id, tracked] of state.subagents) {
    const records = readChild(id, tracked)
    if (records === 'deferred') {
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
      if (!childIsComplete(records)) {
        continue
      }
    }
    changed = true
    finishCodexSubagent(roster, id)
    state.subagents.delete(id)
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
  if (!rolloutCursorReadDeferred(state.parent)) {
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

/** New rollout bytes read off the main thread; nothing in the transcript state moves until they are applied. */
export type CodexSubagentTranscriptReads = {
  parent: JsonlCursor
  parentBytes: JsonlCursorBytes | undefined
  childBytes: Map<TrackedTranscriptSubagent, JsonlCursorBytes | undefined>
}

/** Visits the parent cursor, then each child's after resolving its rollout path asynchronously, one at a time. */
async function visitCodexTranscriptCursors(
  state: CodexSubagentTranscriptState,
  visit: (cursor: JsonlCursor) => Promise<void>,
  current: () => boolean
): Promise<void> {
  const parent = state.parent
  const parentPath = parent.filePath
  await visit(parent)
  if (!parentPath) {
    return
  }
  const entriesByDirectory = new Map<string, string[]>()
  for (const [id, tracked] of [...state.subagents]) {
    // A replaced session or pane makes the rest of this batch unappliable; stop opening its rollouts.
    if (state.parent !== parent || !current() || state.subagents.get(id) !== tracked) {
      return
    }
    if (!tracked.filePath) {
      for (const directory of childTranscriptDirectories(parentPath, tracked.startedAt)) {
        if (!entriesByDirectory.has(directory)) {
          entriesByDirectory.set(directory, await readTranscriptDirectoryAsync(directory))
        }
      }
      tracked.filePath ??= resolveChildTranscript(parentPath, id, tracked.startedAt, (directory) =>
        entriesByDirectory.get(directory)
      )
    }
    await visit(tracked)
  }
}

export async function readCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  current: () => boolean
): Promise<CodexSubagentTranscriptReads> {
  const reads: CodexSubagentTranscriptReads = {
    parent: state.parent,
    parentBytes: undefined,
    childBytes: new Map()
  }
  await visitCodexTranscriptCursors(state, async (cursor) => {
    const bytes = await readJsonlCursorBytes(cursor)
    if (cursor === reads.parent) {
      reads.parentBytes = bytes
    } else {
      reads.childBytes.set(cursor as TrackedTranscriptSubagent, bytes)
    }
  }, current)
  return reads
}

export function prefetchCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  reads: PrefetchedRolloutReads
): Promise<void> {
  return visitCodexTranscriptCursors(
    state,
    (cursor) => prefetchJsonlCursor(reads, cursor),
    () => !reads.closed
  )
}

/** Applies reads in one synchronous step; cursors a hook-driven read moved meanwhile are re-read next poll. Children found by these reads are read next poll. */
export function applyCodexSubagentTranscriptReads(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  reads: CodexSubagentTranscriptReads
): boolean {
  if (state.parent !== reads.parent) {
    return false
  }
  const parentRecords = applyJsonlCursorBytes(
    reads.parent,
    reads.parentBytes,
    isCodexStatusTranscriptLine
  )
  if (parentRecords === 'stale') {
    return false
  }
  const changed = applyCodexParentTranscript(state, roster, parentRecords)
  return (
    applyCodexChildTranscripts(state, roster, (_id, tracked) => {
      if (!reads.childBytes.has(tracked)) {
        return 'deferred'
      }
      const records = applyJsonlCursorBytes(
        tracked,
        reads.childBytes.get(tracked),
        isCodexStatusTranscriptLine
      )
      return records === 'stale' ? 'deferred' : records
    }) || changed
  )
}
