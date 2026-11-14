import type { HookListenerState } from '../listener-state'
import type { AgentProcessIdentity } from '../../agent-status/process/agent-process-presence'
import { beforeDeadline, DEADLINE_PASSED, monotonicNow } from '../../deadline-settle-notifier'
import {
  hookProcessKey,
  type HookRootAttempt,
  type HookRootEvidence,
  type HookRootEvidenceReader,
  type HookRootEvidenceRequest
} from './hook-process-root-evidence'

// One entry per process that tried to acquire a pane; an evicted entry only costs a re-read.
const MAX_HOOK_ROOT_ATTEMPTS = 256
// Beyond this many unfinished reads the host is overloaded: answer unknown, retry next turn.
const MAX_PENDING_HOOK_ROOT_ATTEMPTS = 64
// The hook's curl gives up after 1.5s and spools its event; every hook of one process shares
// this single answer deadline, counted from its first attempt's enqueue.
const HOOK_ROOT_ANSWER_MS = 500
// Queued reads past this budget are abandoned; each running subprocess has its own 1s timeout.
const HOOK_ROOT_WORK_MS = 5_000
// Retrying unproven evidence once per turn bounds the cost to turns, never tool calls.
const TURN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreInvocation'])

/** How a host applies an answer the hook that asked could no longer wait for. */
export type HookRootAcquisition = {
  read: HookRootEvidenceReader
  reconcile?: (completion: HookRootCompletion) => void
  /** A caller running many attempts in turn, such as a spool drain, owns one answer deadline
   *  that no attempt's allowance passes. */
  answerBy?: number
}

/** One answer allowance from now; a spool drain takes one for all of its records. */
export function hookRootAnswerDeadline(): number {
  return monotonicNow() + HOOK_ROOT_ANSWER_MS
}

export type HookRootCompletion = {
  paneKey: string
  worktreeId: string | undefined
  agent: string
  process: AgentProcessIdentity
  attempt: HookRootAttempt
}

// Pane-scoped like the listener's other caches, so pane teardown drops a pane's attempts.
function hookRootKey(paneKey: string, process: AgentProcessIdentity): string {
  return `${paneKey}\0${hookProcessKey(process)}`
}

/** The latest evidence on a process for a pane; an unfinished first read is no evidence yet:
 *  unknown, or status-only for a hinted tmux pane. Undefined: none, or the legacy path. */
export function readHookRootAttempt(
  state: HookListenerState,
  paneKey: string,
  process: AgentProcessIdentity
): HookRootEvidence | undefined {
  const attempt = state.hookRootAttempts.get(hookRootKey(paneKey, process))
  if (!attempt || attempt.evidence === null) {
    return undefined
  }
  return attempt.evidence ?? { verdict: attempt.tmux ? 'unattached' : 'unknown' }
}

function countPending(attempts: ReadonlyMap<string, HookRootAttempt>): number {
  let pending = 0
  for (const attempt of attempts.values()) {
    pending += attempt.pending ? 1 : 0
  }
  return pending
}

/** Join the process's unfinished attempt, or start one when this hook may: a first try, a turn
 *  boundary after unproven evidence, or an exit. Only the first attempt can make a hook wait. */
export function attemptHookRootEvidence(
  state: HookListenerState,
  acquisition: HookRootAcquisition,
  request: HookRootEvidenceRequest,
  hook: { eventName: unknown; exit: boolean; association: string }
): Promise<unknown> | undefined {
  const key = hookRootKey(request.paneKey, request.process)
  const attempts = state.hookRootAttempts
  const existing = attempts.get(key)
  if (existing?.pending) {
    if (hook.exit) {
      existing.exit = hook.association
    }
    return untilAnswerDeadline(existing, acquisition.answerBy)
  }
  // Lineage under another agent outlives every turn; other answers can change.
  if (
    existing &&
    (existing.evidence?.verdict === 'nested' ||
      (!hook.exit && (typeof hook.eventName !== 'string' || !TURN_EVENTS.has(hook.eventName))))
  ) {
    return undefined
  }
  const attempt: HookRootAttempt = {
    evidence: existing?.evidence,
    answerBy: existing?.answerBy ?? hookRootAnswerDeadline(),
    tmux: request.tmux !== undefined,
    association: hook.association,
    ...(hook.exit ? { exit: hook.association } : {})
  }
  attempts.delete(key)
  attempts.set(key, attempt)
  if (countPending(attempts) >= MAX_PENDING_HOOK_ROOT_ATTEMPTS) {
    // Overload never refuses the hook: it reads as an unproven answer and retries next turn.
    attempt.evidence ??= { verdict: attempt.tmux ? 'unattached' : 'unknown' }
  } else {
    const controller = new AbortController()
    const expiry = setTimeout(() => controller.abort(), HOOK_ROOT_WORK_MS)
    expiry.unref?.()
    attempt.pending = acquisition
      .read({ ...request, signal: controller.signal })
      .catch((): HookRootEvidence => ({ verdict: 'unknown' }))
      .then((evidence) => {
        clearTimeout(expiry)
        attempt.evidence = evidence ?? null
        attempt.pending = undefined
        // Why: a hook went on without it; an evicted or cleared attempt is dead.
        if (attempts.get(key) === attempt && attempt.unanswered) {
          acquisition.reconcile?.({ ...request, attempt })
        }
        attempt.exit = undefined
      })
  }
  for (const [oldest, entry] of attempts) {
    if (attempts.size <= MAX_HOOK_ROOT_ATTEMPTS) {
      break
    }
    // An unfinished read keeps its handle; evicting it would start a duplicate.
    if (!entry.pending) {
      attempts.delete(oldest)
    }
  }
  return untilAnswerDeadline(attempt, acquisition.answerBy)
}

/** Past its deadline an attempt costs a hook nothing; its answer reaches the host instead. The
 *  hand-off records what the hook did, since its timer can fire before the clock says so. */
function untilAnswerDeadline(
  attempt: HookRootAttempt,
  callerAnswerBy = Infinity
): Promise<unknown> | undefined {
  if (!attempt.pending) {
    return undefined
  }
  // A caller's deadline only shortens the allowance, and later hooks inherit what it spent.
  attempt.answerBy = Math.min(attempt.answerBy, callerAnswerBy)
  if (monotonicNow() >= attempt.answerBy) {
    attempt.unanswered = true
    return undefined
  }
  return beforeDeadline(attempt.pending, attempt.answerBy).then((answer) => {
    if (answer === DEADLINE_PASSED) {
      attempt.unanswered = true
    }
  })
}
