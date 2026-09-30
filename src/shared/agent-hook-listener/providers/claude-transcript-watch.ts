// Claude records some of what it does only in its session transcript, with no hook: killing every
// background agent on an idle-prompt Ctrl+C (an id-less `system`/`agents_killed` row, the
// claude-idle-ctrl-c-* fixtures), and the end of a background task, however it ended (a
// `queue-operation` row carrying its task notification, the claude-background-shell-* and
// claude-background-workflow-* fixtures).
// The host that runs the session keeps one cursor per pane while any reason to watch holds, reads
// it before every Claude event and on a timer, applies what it reads to the listener's records as
// facts, and restates the row those records now make.
import { existsSync, statSync } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'
import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import {
  claudeRosterHasWorkingSubagent,
  stopWorkingClaudeSubagentsStartedBy
} from '../../claude-subagent-roster'
import {
  createJsonlCursorAtEnd,
  readJsonlCursor,
  type JsonlCursor,
  type JsonRecord
} from '../../codex-rollout-jsonl-cursor'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'
import {
  claudePaneHasLaunchRecordedTask,
  mayBeClaudeTaskEndLine,
  retireClaudeNonAgentTaskFromQueueRow,
  retireClaudeTaskEndedBeforeLaunchHook
} from './claude-non-agent-work'
import { claudeRunningNonAgentTask, clearClaudePendingWaitForAgent } from './claude-roster-state'

/** How the row a fact leaves is attributed, since no hook carries it: a fact that stands for a hook
 *  Claude did not send names it; one that has no hook counterpart names none. */
export type ClaudeTranscriptFactAttribution = { hookEventName?: string; toolAgentId?: string }

type ClaudeTranscriptWatchReason = {
  /** Re-derived from the pane's records at every event and read; never stored. */
  holds: (state: HookListenerState, paneKey: string) => boolean
  /** Substring test on the raw line: a line no watched reason admits is never parsed. */
  admits: (line: string) => boolean
  /** Applies one row to the records; returns its row's attribution, or undefined if nothing changed. */
  apply: (
    state: HookListenerState,
    paneKey: string,
    row: JsonRecord
  ) => ClaudeTranscriptFactAttribution | undefined
}

/** Retires the working agent children an `agents_killed` row says were killed, as SubagentStop would. */
function applyAgentsKilled(
  state: HookListenerState,
  paneKey: string,
  row: JsonRecord
): ClaudeTranscriptFactAttribution | undefined {
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (row.type !== 'system' || row.subtype !== 'agents_killed' || !roster) {
    return undefined
  }
  const stamped = Date.parse(String(row.timestamp))
  const mainAgent = state.claudeLeadStateByPaneKey.get(paneKey)
  const waitOwner = mainAgent?.state === 'waiting' ? mainAgent.waitingAgentId : undefined
  // Why: an unreadable stamp still came after arming, so every child tracked by now was killed.
  const retired = stopWorkingClaudeSubagentsStartedBy(
    roster,
    Number.isNaN(stamped) ? Infinity : stamped
  )
  if (retired.length === 0) {
    return undefined
  }
  clearClaudePendingWaitForAgent(state, paneKey, (agentId) => retired.includes(agentId))
  if (roster.size === 0) {
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
  }
  // Why: a child's own stop releases its held permission prompt, and the desktop re-folds a
  // child's stop under a cancel it inferred but this host never learned of.
  return {
    hookEventName: 'SubagentStop',
    toolAgentId: waitOwner && retired.includes(waitOwner) ? waitOwner : retired[0]
  }
}

/** Every reason to watch. A consumer adds one entry: when it holds, its line test, its fact. */
const CLAUDE_TRANSCRIPT_WATCH_REASONS = {
  /** A working agent child, which Claude can kill with no hook. Dies when the roster has none left:
   *  SubagentStop, an `agents_killed` row, the Stop inventory, SessionStart, pane teardown. */
  'agent-child-working': {
    holds: (state, paneKey) =>
      claudeRosterHasWorkingSubagent(state.claudeSubagentRosterByPaneKey.get(paneKey)),
    admits: (line) => line.includes('"agents_killed"'),
    apply: applyAgentsKilled
  },
  /** A background task whose launch Orca recorded, which Claude can end with no hook (a shell's
   *  /tasks kill, or any task's end after the Ctrl+C that cancelled its turn). Dies when the
   *  record holds no launch-recorded task: its end row, TaskStop, the next inventory, a new
   *  process's SessionStart, pane teardown. */
  'recorded-task': {
    holds: claudePaneHasLaunchRecordedTask,
    admits: mayBeClaudeTaskEndLine,
    apply: (state, paneKey, row) =>
      retireClaudeNonAgentTaskFromQueueRow(state, paneKey, row) ? {} : undefined
  }
} satisfies Record<string, ClaudeTranscriptWatchReason>

export type ClaudeTranscriptWatchReasonName = keyof typeof CLAUDE_TRANSCRIPT_WATCH_REASONS

const REASON_NAMES = Object.keys(CLAUDE_TRANSCRIPT_WATCH_REASONS).filter(
  (name): name is ClaudeTranscriptWatchReasonName => name in CLAUDE_TRANSCRIPT_WATCH_REASONS
)

/** The pane's one transcript cursor. */
export type ClaudeTranscriptCursor = JsonlCursor & {
  filePath: string
  /** Every reason that held since the last read, so that read still serves a reason that ended
   *  before it; reset to the reasons holding after each read. */
  reasons: Set<ClaudeTranscriptWatchReasonName>
  /** A fact read before an event rather than by a tick: the next tick restates its row with this
   *  attribution even when the event's own row already showed it, since a store may have held that. */
  unpublished?: ClaudeTranscriptFactAttribution
  /** Armed on a session file Claude has not created yet: it is read from its start once it exists. */
  awaitingFile?: true
}

/** The reasons to watch that hold now, re-derived from the pane's records. */
export function claudeTranscriptWatchReasons(
  state: HookListenerState,
  paneKey: string
): ClaudeTranscriptWatchReasonName[] {
  return REASON_NAMES.filter((name) => CLAUDE_TRANSCRIPT_WATCH_REASONS[name].holds(state, paneKey))
}

/** The transcript path this host can watch, or undefined. */
export function claudeTranscriptWatchPath(
  transcriptPath: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform === 'win32') {
    // Why: a drive-less rooted path is a WSL guest path or a share; a sync stat there can stall
    // on 9P/SMB, and a WSL session's own guest relay watches its transcript natively.
    return win32.isAbsolute(transcriptPath) && !/^[\\/]/.test(transcriptPath)
      ? transcriptPath
      : undefined
  }
  return posix.isAbsolute(transcriptPath) ? transcriptPath : undefined
}

/** Arms or repoints the pane's cursor from a row the host ACCEPTED, never from an event being
 *  normalized: a nested CLI's refused event must not move the pane's cursor. Returns whether the
 *  pane has a cursor. A change of reasons never resets it; only a new transcript path repoints it,
 *  keeping its reasons: the records, not the session change, decide what they still track. */
export function syncClaudeTranscriptCursor(
  state: HookListenerState,
  accepted: AgentHookEventPayload
): boolean {
  const { paneKey } = accepted
  const cursors = state.claudeTranscriptCursorByPaneKey
  const current = cursors.get(paneKey)
  // Why: a relayed row's session runs on another host, whose own listener watches it; the next
  // tick drops a cursor this pane no longer justifies.
  if (accepted.connectionId !== null || accepted.payload.agentType !== 'claude') {
    return current !== undefined
  }
  const holding = claudeTranscriptWatchReasons(state, paneKey)
  const reported = accepted.providerSession?.transcriptPath
  // Why: a row with no provider session (an OSC repaint) says nothing about the transcript.
  const filePath = reported !== undefined ? claudeTranscriptWatchPath(reported) : current?.filePath
  if (current && current.filePath === filePath) {
    holding.forEach((name) => current.reasons.add(name))
  } else if (!current && holding.length === 0) {
    return false
  } else {
    // Why at the end: a resumed or forked session's file already holds rows written before arming.
    const armed = filePath ? armClaudeTranscriptCursor(filePath) : undefined
    if (!filePath || !armed) {
      cursors.delete(paneKey)
      return false
    }
    cursors.set(paneKey, {
      ...armed,
      filePath,
      reasons: new Set([...(current?.reasons ?? []), ...holding])
    })
  }
  const cursor = cursors.get(paneKey)
  if (cursor && retireClaudeTaskEndedBeforeLaunchHook(state, accepted, cursor)) {
    cursor.unpublished = {}
  }
  return true
}

/** Whether the file is absent from a directory that exists, so Claude can still create it. */
function isClaudeTranscriptFileAwaited(filePath: string): boolean {
  try {
    return !existsSync(filePath) && statSync(dirname(filePath)).isDirectory()
  } catch {
    return false
  }
}

/** A cursor at the file's end, or at its start for a file Claude has not created yet: a cleared
 *  session's file appears after the SessionStart hook that names it (r3-clear-run1: 0.09 s later),
 *  so all of it is written after arming. */
function armClaudeTranscriptCursor(
  filePath: string
): (JsonlCursor & { awaitingFile?: true }) | undefined {
  return (
    createJsonlCursorAtEnd(filePath) ??
    (isClaudeTranscriptFileAwaited(filePath)
      ? { filePath, offset: 0, carry: '', awaitingFile: true }
      : undefined)
  )
}

/** Reads what the pane's existing cursor gained and applies it as facts, in file order. Never
 *  creates or repoints the cursor; an unreadable file drops it. Returns the last fact's attribution. */
function readClaudeTranscript(
  state: HookListenerState,
  paneKey: string
): ClaudeTranscriptFactAttribution | undefined {
  const cursors = state.claudeTranscriptCursorByPaneKey
  const cursor = cursors.get(paneKey)
  if (!cursor) {
    return undefined
  }
  if (cursor.awaitingFile) {
    if (isClaudeTranscriptFileAwaited(cursor.filePath)) {
      return undefined
    }
    delete cursor.awaitingFile
  }
  claudeTranscriptWatchReasons(state, paneKey).forEach((name) => cursor.reasons.add(name))
  const reasons = [...cursor.reasons].map((name) => CLAUDE_TRANSCRIPT_WATCH_REASONS[name])
  const rows = readJsonlCursor(cursor, (line) => reasons.some((reason) => reason.admits(line)))
  if (!rows) {
    cursors.delete(paneKey)
    return undefined
  }
  let attribution: ClaudeTranscriptFactAttribution | undefined
  for (const row of rows) {
    for (const reason of reasons) {
      attribution = reason.apply(state, paneKey, row) ?? attribution
    }
  }
  cursor.reasons = new Set(claudeTranscriptWatchReasons(state, paneKey))
  return attribution
}

/** The catch-up every Claude event runs before it is normalized, so the event folds after every
 *  fact the transcript already recorded. It only reads an existing cursor. */
export function catchUpOnClaudeTranscript(state: HookListenerState, paneKey: string): void {
  const attribution = readClaudeTranscript(state, paneKey)
  const cursor = state.claudeTranscriptCursorByPaneKey.get(paneKey)
  if (attribution && cursor) {
    cursor.unpublished = attribution
  }
}

/** `catchUpOnClaudeTranscript` for a raw hook body, keyed by the pane key it was sent with. */
export function catchUpOnClaudeTranscriptForHookBody(
  state: HookListenerState,
  source: string,
  body: unknown
): void {
  if (source !== 'claude' || typeof body !== 'object' || body === null || !('paneKey' in body)) {
    return
  }
  const paneKey = typeof body.paneKey === 'string' ? body.paneKey.trim() : ''
  if (paneKey) {
    catchUpOnClaudeTranscript(state, paneKey)
  }
}

/** Whether the stored row already shows what the records say. The card counts only while the row
 *  waits: it is then the question on screen, otherwise a tool preview a later hook repaints. */
function claudeRowShowsRecords(
  current: AgentHookEventPayload,
  payload: ParsedAgentStatusPayload,
  runningNonAgentTask: boolean
): boolean {
  const shown = current.payload
  return (
    shown.state === payload.state &&
    shown.workingMode === payload.workingMode &&
    shown.interrupted === payload.interrupted &&
    shown.mainAgent?.state === payload.mainAgent?.state &&
    shown.mainAgent?.outcome === payload.mainAgent?.outcome &&
    JSON.stringify(shown.subagents) === JSON.stringify(payload.subagents) &&
    // Why: a write that is not the listener's (an OSC repaint, an inferred answer) drops the fact
    // on purpose when `mainAgent` moves; restoring it is not the watch's job.
    (current.claudeRunningNonAgentTask === undefined ||
      current.claudeRunningNonAgentTask === runningNonAgentTask) &&
    (payload.state !== 'waiting' ||
      (shown.toolName === payload.toolName &&
        shown.toolInput === payload.toolInput &&
        shown.interactivePrompt === payload.interactivePrompt))
  )
}

/** A row the tick rebuilt from the records. `restatesRecords` marks one that carries no fact: it
 *  only repeats what hooks already offered, so a store that refused those may refuse it too. */
export type ClaudeTranscriptRow = AgentHookEventPayload & { restatesRecords?: true }

export type ClaudeTranscriptObservation =
  | { kind: 'stop' }
  | { kind: 'read'; factApplied: boolean; row?: ClaudeTranscriptRow }

/** One tick: reads the cursor, then rebuilds the row from the records with the hooks' own builder
 *  and returns it when the stored row does not show it yet, or when a fact named how it is
 *  attributed. Compares against the host's stored row: on the desktop that is the row after its
 *  cancel latch and permission hold, on a relay its own cache (no latch, no hold). */
export function observeClaudeTranscript(
  state: HookListenerState,
  paneKey: string
): ClaudeTranscriptObservation {
  const current = state.lastStatusByPaneKey.get(paneKey)
  // Why kept, not dropped: a row removed with no teardown comes back at the next event, whose
  // sync resumes the watch from where it stopped.
  if (!current) {
    return { kind: 'stop' }
  }
  if (current.payload.agentType !== 'claude' || current.connectionId !== null) {
    state.claudeTranscriptCursorByPaneKey.delete(paneKey)
    return { kind: 'stop' }
  }
  const read = readClaudeTranscript(state, paneKey)
  const cursor = state.claudeTranscriptCursorByPaneKey.get(paneKey)
  const attribution = read ?? cursor?.unpublished
  if (cursor) {
    delete cursor.unpublished
  }
  const payload = buildClaudeCachedLeadStatusPayload(state, attribution?.hookEventName, paneKey, {})
  const runningNonAgentTask = claudeRunningNonAgentTask(state, paneKey)
  // Why: the watch restates a row, it never brings back one the user dismissed; only a fact, which
  // stands for the hook Claude did not send, does what that hook would have.
  const unchanged =
    !payload ||
    (!attribution &&
      (current.providerSessionOnly === true ||
        claudeRowShowsRecords(current, payload, runningNonAgentTask)))
  // Why: a row still waiting keeps the hook that raised the wait, which the store's permission
  // rules key on; a fact that retired the wait's owner already ended the wait. Any other row is
  // an observation.
  const keepsWait = payload?.state === 'waiting' && current.hookEventName !== undefined
  const hook = keepsWait
    ? {
        hookEventName: current.hookEventName,
        toolAgentId: current.toolAgentId,
        toolUseId: current.toolUseId,
        toolAgentType: current.toolAgentType
      }
    : (attribution ?? {})
  return {
    kind: 'read',
    factApplied: read !== undefined,
    ...(unchanged || !payload
      ? {}
      : {
          row: {
            paneKey,
            source: 'claude',
            launchToken: current.launchToken,
            tabId: current.tabId,
            worktreeId: current.worktreeId,
            connectionId: null,
            ...hook,
            ...(attribution ? { transcriptFact: true } : { restatesRecords: true }),
            claudeRunningNonAgentTask: runningNonAgentTask,
            ...(current.providerSession ? { providerSession: current.providerSession } : {}),
            payload
          }
        })
  }
}

/** Keeps the cursor after a tick only while a reason holds or the read applied a fact, so a fact
 *  the read found is followed by one more read. Returns whether the pane is still armed. */
export function settleClaudeTranscriptWatch(
  state: HookListenerState,
  paneKey: string,
  factApplied: boolean
): boolean {
  const cursors = state.claudeTranscriptCursorByPaneKey
  const cursor = cursors.get(paneKey)
  if (cursor && !factApplied && claudeTranscriptWatchReasons(state, paneKey).length === 0) {
    cursors.delete(paneKey)
    return false
  }
  return cursor !== undefined
}
