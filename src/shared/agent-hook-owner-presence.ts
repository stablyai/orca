import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import type { AgentHookSource } from './agent-hook-relay'
import {
  hasOtherAgentProcessOwner,
  isSameAgentProcess,
  readHookAgentProcess,
  type AgentProcessIdentity
} from './agent-process-presence'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'
import { beforeDeadline, monotonicNow } from './deadline-settle-notifier'
import {
  hookProcessKey,
  type HookProcessVerdict,
  type HookRootAttempt,
  type HookRootEvidenceReader,
  type HookRootEvidenceRequest
} from './hook-process-root-evidence'
import { readTmuxHookPane, readTmuxHookPaneHint } from './tmux-client-attachment'

// One entry per process that tried to acquire a pane; an evicted entry only costs a re-read.
const MAX_HOOK_ROOT_ATTEMPTS = 256
// The hook's curl gives up after 1.5s and spools its event; every hook joining one attempt shares
// this single answer deadline, and the attempt keeps running for the hooks after it.
const HOOK_ROOT_ANSWER_MS = 500
// A root verdict rests on the pane's foreground, which can change; consume it only while fresh.
const ROOT_VERDICT_FRESH_MS = 10_000
// Retrying unproven evidence once per turn bounds the cost to turns, never tool calls.
const TURN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit'])

/** A process-bearing hook into a pane with no live proven owner acquires new authority, so it
 *  must show it belongs to the pane's own job, whether or not a row exists yet. */
export function needsHookRootEvidence(
  previous: AgentHookEventPayload | undefined,
  process: AgentProcessIdentity | undefined
): process is AgentProcessIdentity {
  const owner = previous?.providerSessionOnly ? undefined : previous?.agentPresence
  return Boolean(
    process &&
    // A retired owner's own process is refused outright, never re-examined.
    !(owner?.process && (!owner.ended || isSameAgentProcess(owner.process, process)))
  )
}

function hookRootKey(paneKey: string, process: AgentProcessIdentity): string {
  return `${paneKey}\n${hookProcessKey(process)}`
}

function usableVerdict(attempt: HookRootAttempt): HookProcessVerdict | undefined {
  if (attempt.pending) {
    // An answer that missed its deadline is not evidence yet; it grants nothing.
    return 'unknown'
  }
  return attempt.verdict === 'root' &&
    monotonicNow() - (attempt.completedAt ?? -Infinity) > ROOT_VERDICT_FRESH_MS
    ? 'unknown'
    : attempt.verdict
}

/** The execution host's verdict on this hook's process for the pane. Undefined keeps the legacy
 *  path: no evidence applies, or this host or endpoint cannot bind the pane's root. */
export function readHookProcessVerdict(
  state: HookListenerState,
  previous: AgentHookEventPayload | undefined,
  hook: { paneKey: string; process: AgentProcessIdentity | undefined }
): HookProcessVerdict | undefined {
  if (!needsHookRootEvidence(previous, hook.process)) {
    return undefined
  }
  const attempt = state.hookRootAttempts.get(hookRootKey(hook.paneKey, hook.process))
  return attempt ? usableVerdict(attempt) : undefined
}

/** Refuse before provider folds: the retired owner's own late hook, or a process the execution
 *  host proved is nested under, competing with or foreign to the pane's agent. */
export function readHookProcessAdmission(
  state: HookListenerState,
  rows: ReadonlyMap<string, AgentHookEventPayload>,
  hook: {
    paneKey: string
    worktreeId: string | undefined
    process: AgentProcessIdentity | undefined
  }
): { refused: boolean; verdict: HookProcessVerdict | undefined } {
  const previous = readLocalHookOwnerRow(rows, hook.paneKey, hook.worktreeId)
  const owner = previous?.agentPresence
  const verdict = readHookProcessVerdict(state, previous, hook)
  const retired = Boolean(
    hook.process && owner?.ended && owner.process && isSameAgentProcess(owner.process, hook.process)
  )
  return { refused: retired || verdict === 'nested' || verdict === 'competing', verdict }
}

/** The pane's committed row when a hook posted on this host could belong to it. */
export function readLocalHookOwnerRow(
  rows: ReadonlyMap<string, AgentHookEventPayload>,
  paneKey: string,
  worktreeId: string | undefined
): AgentHookEventPayload | undefined {
  const row = rows.get(paneKey)
  return row &&
    sameAgentStatusTerminalOwner(
      { connectionId: row.connectionId ?? null, worktreeId: row.worktreeId },
      { connectionId: null, worktreeId }
    )
    ? row
    : undefined
}

function readHookPaneOwner(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string
) {
  const envelope = parseHookEnvelope(state, source, body, env)
  if (!envelope) {
    return undefined
  }
  const previous = readLocalHookOwnerRow(
    state.lastStatusByPaneKey,
    envelope.paneKey,
    envelope.worktreeId
  )
  return {
    envelope,
    owner: previous && !previous.providerSessionOnly ? previous.agentPresence : undefined,
    sender: { agent: source, process: readHookAgentProcess(source, envelope.record.agentProcess) }
  }
}

/** Join the pane's current attempt, or start one when this hook may: a first try, a turn
 *  boundary after unproven evidence, a stale root, or an exit, which needs fresh proof. */
function attemptHookRootEvidence(
  state: HookListenerState,
  read: HookRootEvidenceReader,
  request: HookRootEvidenceRequest,
  eventName: unknown
): Promise<unknown> | undefined {
  const key = hookRootKey(request.paneKey, request.process)
  const attempts = state.hookRootAttempts
  const existing = attempts.get(key)
  if (existing?.pending) {
    return beforeDeadline(existing.pending, existing.answerBy)
  }
  // Lineage under another agent outlives every turn; other answers can change.
  if (
    existing &&
    (existing.verdict === 'nested' ||
      (eventName !== 'SessionEnd' &&
        (existing.verdict === 'root'
          ? usableVerdict(existing) === 'root'
          : typeof eventName !== 'string' || !TURN_EVENTS.has(eventName))))
  ) {
    return undefined
  }
  const attempt: HookRootAttempt = { answerBy: monotonicNow() + HOOK_ROOT_ANSWER_MS }
  const pending = read(request)
    .catch(() => 'unknown' as const)
    .then((verdict) => {
      attempt.verdict = verdict
      attempt.completedAt = monotonicNow()
      attempt.pending = undefined
    })
  attempt.pending = pending
  attempts.delete(key)
  attempts.set(key, attempt)
  for (const oldest of attempts.keys()) {
    if (attempts.size <= MAX_HOOK_ROOT_ATTEMPTS) {
      break
    }
    attempts.delete(oldest)
  }
  return beforeDeadline(pending, attempt.answerBy)
}

/** Confirm an old owner's exit on its execution host before accepting a replacement, then read
 *  whether a process acquiring the pane belongs to its job; both settle before provider folds. */
export function checkHookOwnerPresence(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string,
  check: (paneKey: string) => Promise<unknown>,
  readRootEvidence?: HookRootEvidenceReader
): Promise<unknown> | undefined {
  const hook = readHookPaneOwner(state, source, body, env)
  if (!hook) {
    return undefined
  }
  const { envelope, sender } = hook
  const acquire = (): Promise<unknown> | undefined => {
    const process = sender.process
    // The challenge may have retired the owner; read the row it left.
    const previous = readLocalHookOwnerRow(
      state.lastStatusByPaneKey,
      envelope.paneKey,
      envelope.worktreeId
    )
    if (!readRootEvidence || !needsHookRootEvidence(previous, process)) {
      return undefined
    }
    const tmux =
      readTmuxHookPane(envelope.record.tmux) ?? readTmuxHookPaneHint(envelope.record.tmuxPane)
    return attemptHookRootEvidence(
      state,
      readRootEvidence,
      {
        paneKey: envelope.paneKey,
        worktreeId: envelope.worktreeId,
        agent: source,
        process,
        ...(tmux ? { tmux } : {})
      },
      envelope.eventName
    )
  }
  // A suspended owner may have resumed without emitting another hook.
  if (hasOtherAgentProcessOwner(hook.owner && { ...hook.owner, suspended: undefined }, sender)) {
    return check(envelope.paneKey).then(acquire)
  }
  return acquire()
}

/** Another live process of the owner's provider posted this hook, e.g. a nested `claude -p`. */
export function isOwnerProviderGuestHook(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string
): boolean {
  const hook = readHookPaneOwner(state, source, body, env)
  return Boolean(
    hook && hook.owner?.agent === source && hasOtherAgentProcessOwner(hook.owner, hook.sender)
  )
}
