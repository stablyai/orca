import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

import {
  finishCodexSubagent,
  setCodexSubagentModel,
  upsertCodexSubagent,
  type CodexSubagentRoster
} from './codex-subagent-roster'
import { resolveCodexChildTranscript } from './codex-subagent-transcript-paths'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
// Why: retire a child whose rollout stays unreadable this long, else a deleted/never-written file pins a phantom row forever.
const CHILD_UNREADABLE_GRACE_MS = 60_000
const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/

type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
  coverageAuthoritative: boolean
}

type TrackedTranscriptSubagent = JsonlCursor & {
  description?: string
  /** Retained because incremental reads usually omit the earlier `turn_context`. */
  model?: string
  restoredState?: 'working' | 'waiting'
  restoredFromSnapshot?: true
  startedAt: number
  unresolvedSince?: number
}

export type CodexSubagentTranscriptState = {
  parent: JsonlCursor
  subagents: Map<string, TrackedTranscriptSubagent>
  parentTerminalObserved?: boolean
  parentReadable?: boolean
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

/** Returns undefined when the file is unreadable, distinguishing a vanished rollout from one with no new lines. */
function readJsonlCursor(cursor: JsonlCursor): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  let stats: Stats
  try {
    stats = statSync(cursor.filePath)
  } catch {
    return undefined
  }
  if (!stats.isFile()) {
    return undefined
  }
  if (stats.size < cursor.offset) {
    cursor.offset = 0
    cursor.carry = ''
    cursor.coverageAuthoritative = false
  }
  if (stats.size === cursor.offset) {
    if (cursor.offset === 0) {
      cursor.coverageAuthoritative = true
    }
    return []
  }
  const bytesToRead = Math.min(stats.size - cursor.offset, TRANSCRIPT_READ_MAX_BYTES)
  const start = stats.size - cursor.offset > bytesToRead ? stats.size - bytesToRead : cursor.offset
  const buffer = Buffer.allocUnsafe(bytesToRead)
  let bytesRead = 0
  let fd: number | undefined
  try {
    fd = openSync(cursor.filePath, 'r')
    bytesRead = readSync(fd, buffer, 0, bytesToRead, start)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
  const skippedPrefix = start !== cursor.offset
  if (skippedPrefix) {
    cursor.coverageAuthoritative = false
  }
  if (start === 0 && cursor.offset === 0) {
    cursor.coverageAuthoritative = true
  }
  const content = `${skippedPrefix ? '' : cursor.carry}${buffer.toString('utf8', 0, bytesRead)}`
  const lines = content.split('\n')
  cursor.offset = start + bytesRead
  cursor.carry = lines.pop() ?? ''
  if (skippedPrefix) {
    lines.shift()
  }
  const records: JsonRecord[] = []
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES) {
      continue
    }
    try {
      const parsed = record(JSON.parse(line) as unknown)
      if (parsed) {
        records.push(parsed)
      }
    } catch {}
  }
  return records
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

/** Read from the child's rollout because its model can differ from the parent's. */
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

function childIsComplete(records: JsonRecord[]): boolean {
  let lifecycle: unknown
  for (const recordValue of records) {
    const eventType =
      recordValue.type === 'event_msg' ? record(recordValue.payload)?.type : undefined
    if (eventType === 'task_started' || eventType === 'task_complete') {
      lifecycle = eventType
    }
  }
  return lifecycle === 'task_complete'
}

export function createCodexSubagentTranscriptState(): CodexSubagentTranscriptState {
  return {
    parent: { offset: 0, carry: '', coverageAuthoritative: false },
    subagents: new Map()
  }
}

export function hasTrackedCodexTranscriptSubagents(
  state: CodexSubagentTranscriptState | undefined
): boolean {
  return Boolean(
    state && [...state.subagents.values()].some((subagent) => !subagent.restoredFromSnapshot)
  )
}

export function reconcileCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  transcriptPath: string | undefined
): void {
  const normalizedPath = transcriptPath?.trim()
  if (!normalizedPath || !isAbsolute(normalizedPath) || extname(normalizedPath) !== '.jsonl') {
    state.parentReadable = false
    return
  }
  if (state.parent.filePath !== normalizedPath) {
    for (const id of state.subagents.keys()) {
      finishCodexSubagent(roster, id)
    }
    state.parent = { filePath: normalizedPath, offset: 0, carry: '', coverageAuthoritative: false }
    state.subagents.clear()
    state.parentTerminalObserved = undefined
    state.parentReadable = undefined
  }
  const parentRecords = readJsonlCursor(state.parent)
  state.parentReadable = parentRecords !== undefined
  for (const recordValue of parentRecords ?? []) {
    if (recordValue.type === 'event_msg') {
      const eventType = record(recordValue.payload)?.type
      if (eventType === 'task_started' || eventType === 'task_complete') {
        state.parentTerminalObserved = eventType === 'task_complete'
      }
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
      coverageAuthoritative: false,
      startedAt: activity.startedAt
    }
    tracked.description = activity.description ?? tracked.description
    tracked.restoredFromSnapshot = undefined
    state.subagents.set(activity.id, tracked)
    upsertCodexSubagent(
      roster,
      activity.id,
      { description: tracked.description, state: tracked.restoredState ?? 'working' },
      tracked.startedAt
    )
  }
  for (const tracked of state.subagents.values()) {
    if (!tracked.restoredFromSnapshot) {
      tracked.restoredState = undefined
    }
  }
  const entriesByDirectory = new Map<string, string[]>()
  const now = Date.now()
  for (const [id, tracked] of state.subagents) {
    if (!tracked.filePath) {
      tracked.filePath = resolveCodexChildTranscript(
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
        tracked.restoredFromSnapshot = undefined
        tracked.restoredState = undefined
        continue
      }
    }
    finishCodexSubagent(roster, id)
    state.subagents.delete(id)
  }
}
