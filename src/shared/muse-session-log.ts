import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readJsonlCursor,
  record,
  type JsonlCursor,
  type JsonRecord
} from './codex-rollout-jsonl-cursor'

// Muse stores local-date shards under <XDG_DATA_HOME>/muse/sessions (default ~/.local/share/muse/sessions): YYYY/MM/DD/<uuid>/session.jsonl. No upstream override exists.
export function resolveMuseSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return join(dataHome, 'muse', 'sessions')
}

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 24 * 60 * 60 * 1000

function dayParts(date: Date, utc: boolean): string[] {
  const year = utc ? date.getUTCFullYear() : date.getFullYear()
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const day = utc ? date.getUTCDate() : date.getDate()
  return [String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')]
}

/** Locates a live session's log from its UUIDv7 id, whose timestamp names the date shard. */
export function findMuseSessionLogPath(
  sessionId: string,
  sessionsDir = resolveMuseSessionsDir()
): string | undefined {
  const match = UUID_V7.exec(sessionId)
  if (!match) {
    return undefined
  }
  const startedAt = Number.parseInt(`${match[1]}${match[2]}`, 16)
  const candidates = new Set<string>()
  // Why: the shard uses Muse's local zone, which can differ from ours (relay, TZ env), so probe neighbors.
  for (const offset of [0, -DAY_MS, DAY_MS]) {
    const date = new Date(startedAt + offset)
    for (const utc of [false, true]) {
      candidates.add(join(sessionsDir, ...dayParts(date, utc), sessionId, 'session.jsonl'))
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

export type MuseUserInputQuestion = Record<string, unknown>

export type MusePendingUserInput = {
  promptId: string
  /** Muse run that asked; equals the hook payload's `turn_id`. */
  runId?: string
  questions: MuseUserInputQuestion[]
}

export type MuseSessionLogState = {
  sessionId: string
  cursor: JsonlCursor
  pending: Map<string, MusePendingUserInput>
  /** Background workflows this Muse process launched and the log has not settled, by task id. */
  workflows: Map<string, MuseBackgroundWorkflow>
}

export type MuseBackgroundWorkflow = {
  /** Lead run whose `workflow` tool launched it; Muse wakes the lead in a later run once it ends. */
  launchTurnId?: string
  lastActivityAt: number
}

const USER_INPUT_PROMPT_MARKER = '"user_input_prompt_'
const SETTLED_TASK_KINDS = ['completed', 'failed', 'cancelled']
const TASK_SETTLED_MARKERS = SETTLED_TASK_KINDS.map((kind) => `"event":{"kind":"${kind}"`)

export function createMuseSessionLogState(sessionId: string): MuseSessionLogState {
  return { sessionId, cursor: { offset: 0, carry: '' }, pending: new Map(), workflows: new Map() }
}

/** Muse batches some records into a `retained_frame` whose `children[].record_json` hold them as strings. */
export function unwrapMuseLogRecords(line: JsonRecord): JsonRecord[] {
  if (!Array.isArray(line.children)) {
    return [line]
  }
  const records: JsonRecord[] = []
  for (const child of line.children) {
    const raw: unknown = record(child)?.record_json
    let value: unknown = raw
    try {
      value = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      value = undefined
    }
    const parsed = record(value)
    if (parsed) {
      records.push(parsed)
    }
  }
  return records
}

function applyUserInputRecord(log: MuseSessionLogState, entry: JsonRecord): void {
  const payload = record(entry.payload)
  const event = record(payload?.event)
  const promptId = typeof event?.prompt_id === 'string' ? event.prompt_id : undefined
  if (!event || !promptId) {
    return
  }
  if (event.kind === 'user_input_prompt_requested') {
    const questions = Array.isArray(event.questions)
      ? event.questions.flatMap((question: unknown) => {
          const item = record(question)
          return item ? [item] : []
        })
      : []
    const runId = typeof payload?.run_id === 'string' ? payload.run_id : undefined
    log.pending.delete(promptId)
    log.pending.set(promptId, { promptId, runId, questions })
  } else if (event.kind === 'user_input_prompt_settled') {
    log.pending.delete(promptId)
  }
}

function applyTaskSettledRecord(log: MuseSessionLogState, entry: JsonRecord): void {
  const payload = record(entry.payload)
  const kind = record(payload?.event)?.kind
  if (
    payload?.kind === 'task' &&
    typeof payload.task_id === 'string' &&
    typeof kind === 'string' &&
    SETTLED_TASK_KINDS.includes(kind)
  ) {
    log.workflows.delete(payload.task_id)
  }
}

function readsLine(line: string): boolean {
  return (
    line.includes(USER_INPUT_PROMPT_MARKER) ||
    TASK_SETTLED_MARKERS.some((marker) => line.includes(marker))
  )
}

/** Returns false while the log cannot be read. */
function advanceMuseSessionLog(log: MuseSessionLogState, sessionsDir?: string): boolean {
  log.cursor.filePath ??= findMuseSessionLogPath(log.sessionId, sessionsDir)
  // Why: most log lines are large model/tool records; parse only the event kinds we read.
  const lines = readJsonlCursor(log.cursor, readsLine)
  for (const line of lines ?? []) {
    for (const entry of unwrapMuseLogRecords(line)) {
      applyUserInputRecord(log, entry)
      applyTaskSettledRecord(log, entry)
    }
  }
  return lines !== undefined
}

/** Tracks the workflow a `workflow` tool result reports as launched; only live hooks start one. */
export function recordMuseWorkflowLaunch(
  log: MuseSessionLogState,
  toolResponse: unknown,
  launchTurnId: string | undefined,
  now: number
): void {
  let response = toolResponse
  if (typeof toolResponse === 'string') {
    try {
      response = JSON.parse(toolResponse)
    } catch {
      return
    }
  }
  const result = record(response)
  if (result?.status === 'launched' && typeof result.taskId === 'string') {
    log.workflows.set(result.taskId, { launchTurnId, lastActivityAt: now })
  }
}

/** Advances the log and counts launched workflows it has not settled; an unreadable log or quiet workflow stops counting. */
export function readMuseRunningWorkflows(
  log: MuseSessionLogState,
  now: number,
  inactivityLimitMs: number,
  sessionsDir?: string
): number {
  // Why: settlement exists only in the log, so work it cannot see must not hold the pane open.
  if (!advanceMuseSessionLog(log, sessionsDir)) {
    log.workflows.clear()
    return 0
  }
  for (const [taskId, workflow] of log.workflows) {
    if (now - workflow.lastActivityAt >= inactivityLimitMs) {
      log.workflows.delete(taskId)
    }
  }
  return log.workflows.size
}

/** Advances the log and returns the newest unanswered `request_user_input` prompt of `turnId`'s run. */
export function readMusePendingUserInput(
  log: MuseSessionLogState,
  turnId: string | undefined,
  sessionsDir?: string
): MusePendingUserInput | undefined {
  advanceMuseSessionLog(log, sessionsDir)
  // Why: a question left open by a crash or interrupt stays in the log; only the live turn's can block.
  const pending = Array.from(log.pending.values())
  return pending.findLast((prompt) => !turnId || !prompt.runId || prompt.runId === turnId)
}
