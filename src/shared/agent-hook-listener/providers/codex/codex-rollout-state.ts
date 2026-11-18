import { record, type JsonRecord } from './codex-rollout-jsonl-format'
import { normalizedTranscriptPath } from './codex-rollout-paths'
import { reconcileCodexTranscriptTurn, type CodexTranscriptTurn } from './codex-turn-transcript'
import { readApprovalsReviewer, type CodexApprovalsReviewer } from './codex-subagent-reviewer'

const MAX_TRACKED_TURN_ENDS = 16
const MAX_CHILD_ROLLOUTS = 64

/** One rollout Orca reads; at most one read of it is in flight. */
export type CodexRolloutFile = {
  cursor: { filePath: string; offset: number; carry: string }
  reviewer?: CodexApprovalsReviewer
  /** Latest reviewer request; a read that started after it satisfies it. */
  wanted: number
  resolved: number
  reading: boolean
  readAgain: boolean
  /** A live child whose own rollout records how its turn ended. */
  childId?: string
  /** The child's turn as its rollout last showed it; the last lifecycle record wins. */
  childTurnOpen?: boolean
  childTurnAborted?: boolean
  unreadableSince?: number
}

/**
 * A PermissionRequest whose classification a reviewer read still has to confirm; `overdue` once
 * its read outlived the wait and a fallback state was shown meanwhile. Ordering rule: only the
 * approved tool's PostToolUse (`toolKey`) or the turn moving on (`epoch`) answers it; a parallel
 * tool's hooks do not, so the approval still reaches Needs you.
 */
export type CodexApprovalHold = {
  filePath: string
  seq: number
  heldAt: number
  toolKey: string
  /** The state shown meanwhile; settling changes it only if the reviewer read disagrees. */
  shown: 'working' | 'waiting'
  overdue?: true
}

/**
 * A child's ended turn: `hooks` is the child's hook count when the read that saw it started.
 * An abort can be a turn replaced by a follow-up (its task_started comes right after), so it
 * applies only once a read that started CODEX_CHILD_ABORT_SETTLE_MS later still shows it.
 */
export type CodexChildEnd = { hooks: number; at: number; aborted: boolean; settled: boolean }

export const CODEX_CHILD_ABORT_SETTLE_MS = 2_000

export type CodexRolloutState = {
  /**
   * Ordering rule: bumped whenever the root turn moves on (prompt, Stop, Interrupt, new rollout).
   * A root read that started under an older epoch is dropped, cursor included, so a late read
   * can never undo a hook that already settled or restarted the turn.
   */
  epoch: number
  /** The rollout the latest root hook named; /review moves it to the review rollout. */
  root?: CodexRolloutFile
  rootTurn: CodexTranscriptTurn
  turnEnds: Map<string, 'completed' | 'failed'>
  /** `cli_version` from the root rollout's session_meta, when the read reached the first line. */
  cliVersion?: string
  /** Child rollouts: reviewer ownership, and for live children how their turn ended. */
  childFiles: Map<string, CodexRolloutFile>
  /**
   * Children whose rollout showed their turn ended (errored, interrupted, or aborted at session end: Codex sends no
   * SubagentStop for those), with the child's hook count when that read started. Ordering rule:
   * a hook for the child after the read started proves it alive, so the end does not apply.
   */
  childEnds: Map<string, CodexChildEnd>
  rootApprovalHold?: CodexApprovalHold & { epoch: number; model?: string }
  requestSeq: number
  /** When the latest root hook arrived; the tail reads the root only once hooks go quiet. */
  lastRootHookAt?: number
  /** The reviewer request this turn's UserPromptSubmit made. */
  turnReviewerRequest?: number
}

function createRolloutFile(filePath: string): CodexRolloutFile {
  return {
    cursor: { filePath, offset: 0, carry: '' },
    wanted: 0,
    resolved: 0,
    reading: false,
    readAgain: false
  }
}

export function createCodexRolloutState(): CodexRolloutState {
  return {
    epoch: 0,
    rootTurn: { interrupted: false },
    turnEnds: new Map(),
    childFiles: new Map(),
    childEnds: new Map(),
    requestSeq: 0
  }
}

/** Follow the rollout a root hook named; a different rollout is a different thread. */
export function followCodexRootRollout(
  rollout: CodexRolloutState,
  transcriptPath: string | undefined
): void {
  const filePath = normalizedTranscriptPath(transcriptPath)
  if (!filePath || rollout.root?.cursor.filePath === filePath) {
    return
  }
  rollout.epoch += 1
  rollout.root = createRolloutFile(filePath)
  rollout.rootTurn = { interrupted: false }
  rollout.turnEnds.clear()
  rollout.cliVersion = undefined
  rollout.rootApprovalHold = undefined
  rollout.turnReviewerRequest = undefined
}

/** Ask for a fresh reviewer read of a rollout; returns the request a later read must satisfy. */
export function requestCodexRolloutReviewer(rollout: CodexRolloutState, filePath: string): number {
  let file =
    rollout.root?.cursor.filePath === filePath ? rollout.root : rollout.childFiles.get(filePath)
  if (!file) {
    file = addChildRolloutFile(rollout, filePath)
  }
  rollout.requestSeq += 1
  file.wanted = rollout.requestSeq
  return file.wanted
}

export function codexRolloutFile(
  rollout: CodexRolloutState,
  filePath: string
): CodexRolloutFile | undefined {
  return rollout.root?.cursor.filePath === filePath
    ? rollout.root
    : rollout.childFiles.get(filePath)
}

/** Which tool an approval is for; Codex's PermissionRequest carries no tool_use_id. */
export function codexApprovalToolKey(hookPayload: Record<string, unknown>): string {
  const input = record(hookPayload.tool_input)
  // PermissionRequest's tool_input adds the escalation justification (and a network target) as
  // `description`; PostToolUse carries the call's own input, so key on what both share.
  const command = input?.command
  const subject =
    command !== undefined
      ? command
      : input && Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'description'))
  return `${String(hookPayload.tool_name ?? '')}\n${JSON.stringify(subject ?? null)}`
}

function addChildRolloutFile(rollout: CodexRolloutState, filePath: string): CodexRolloutFile {
  if (rollout.childFiles.size >= MAX_CHILD_ROLLOUTS) {
    // Evict reviewer-only files first; a followed child's file ends with the child.
    const evictable = [...rollout.childFiles].find(([, file]) => file.childId === undefined)
    const oldest = evictable?.[0] ?? rollout.childFiles.keys().next().value
    if (typeof oldest === 'string') {
      rollout.childFiles.delete(oldest)
    }
  }
  const file = createRolloutFile(filePath)
  rollout.childFiles.set(filePath, file)
  return file
}

/** Follow a live child's own rollout, whose turn end is the only record of an errored or stopped child. */
export function followCodexChildRollout(
  rollout: CodexRolloutState,
  childId: string,
  filePath: string
): CodexRolloutFile {
  const file = rollout.childFiles.get(filePath) ?? addChildRolloutFile(rollout, filePath)
  file.childId = childId
  return file
}

/** Stop following a finished child's rollout. */
export function forgetCodexChildRollout(rollout: CodexRolloutState, childId: string): void {
  rollout.childEnds.delete(childId)
  for (const [filePath, file] of rollout.childFiles) {
    if (file.childId === childId) {
      rollout.childFiles.delete(filePath)
    }
  }
}

function lifecycleType(recordValue: JsonRecord): string | undefined {
  const payload = record(recordValue.payload)
  return recordValue.type === 'event_msg' && typeof payload?.type === 'string'
    ? payload.type
    : undefined
}

/** A parent's record that it interrupted a child (persisted by Codex before 0.150). */
function readInterruptedChild(recordValue: JsonRecord): string | undefined {
  const payload = record(recordValue.payload)
  return lifecycleType(recordValue) === 'sub_agent_activity' &&
    payload?.kind === 'interrupted' &&
    typeof payload.agent_thread_id === 'string'
    ? payload.agent_thread_id.trim() || undefined
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

function readCliVersion(recordValue: JsonRecord): string | undefined {
  const version = record(recordValue.payload)?.cli_version
  return recordValue.type === 'session_meta' && typeof version === 'string'
    ? version.trim() || undefined
    : undefined
}

/** Apply a finished read: `read` undefined means the rollout was unreadable. `childHooks` holds
 *  each child's hook count when the read started. */
export function commitCodexRolloutRead(
  rollout: CodexRolloutState,
  file: CodexRolloutFile,
  records: JsonRecord[] | undefined,
  satisfies: number,
  childHooks: ReadonlyMap<string, number>,
  now: number,
  readStartedAt: number = now
): void {
  file.resolved = Math.max(file.resolved, satisfies)
  if (!records) {
    // A stale reviewer must never turn an unreadable rollout into a hidden prompt.
    file.reviewer = undefined
    file.unreadableSince ??= now
    return
  }
  file.unreadableSince = undefined
  file.reviewer = readApprovalsReviewer(records) ?? file.reviewer
  const markEnded = (childId: string, aborted: boolean): void => {
    const hooks = childHooks.get(childId)
    if (hooks === undefined) {
      return
    }
    const previous = rollout.childEnds.get(childId)
    const same = previous?.hooks === hooks && previous.aborted === aborted
    const at = same ? previous.at : now
    rollout.childEnds.set(childId, {
      hooks,
      at,
      aborted,
      settled: !aborted || readStartedAt - at >= CODEX_CHILD_ABORT_SETTLE_MS
    })
  }
  for (const recordValue of records) {
    const interrupted = readInterruptedChild(recordValue)
    if (interrupted) {
      markEnded(interrupted, false)
    }
    if (!file.childId) {
      continue
    }
    const type = lifecycleType(recordValue)
    if (type === 'task_started' || type === 'turn_started') {
      file.childTurnOpen = true
    } else if (type === 'task_complete' || type === 'turn_complete' || type === 'turn_aborted') {
      file.childTurnOpen = false
      file.childTurnAborted = type === 'turn_aborted'
    }
  }
  if (file.childId && file.childTurnOpen !== undefined) {
    if (file.childTurnOpen) {
      rollout.childEnds.delete(file.childId)
    } else {
      markEnded(file.childId, file.childTurnAborted === true)
    }
  }
  if (file !== rollout.root) {
    return
  }
  reconcileCodexTranscriptTurn(rollout.rootTurn, records)
  for (const recordValue of records) {
    rollout.cliVersion = readCliVersion(recordValue) ?? rollout.cliVersion
    const turnEnd = readTurnEnd(recordValue)
    if (!turnEnd) {
      continue
    }
    rollout.turnEnds.delete(turnEnd.turnId)
    rollout.turnEnds.set(turnEnd.turnId, turnEnd.end)
    const oldest = rollout.turnEnds.keys().next()
    if (rollout.turnEnds.size > MAX_TRACKED_TURN_ENDS && !oldest.done) {
      rollout.turnEnds.delete(oldest.value)
    }
  }
}

export function codexTranscriptTurnEnd(
  rollout: CodexRolloutState | undefined,
  turnId: string
): 'completed' | 'failed' | undefined {
  return rollout?.turnEnds.get(turnId)
}

/** The root turn's reviewer once a read made for this turn landed. Codex writes turn_context
 *  (and its settings) before the turn's UserPromptSubmit hook, so that read already holds it. */
export function codexTurnReviewer(
  rollout: CodexRolloutState,
  filePath: string
): CodexApprovalsReviewer | undefined {
  const root = rollout.root
  return root?.cursor.filePath === filePath &&
    rollout.turnReviewerRequest !== undefined &&
    root.resolved >= rollout.turnReviewerRequest
    ? root.reviewer
    : undefined
}
