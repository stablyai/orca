import { isProcessExitSessionEnd, parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import type { AgentHookSource } from './agent-hook-relay'
import {
  hasOtherAgentProcessOwner,
  isSameAgentProcess,
  readHookAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from './agent-process-presence'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'
import {
  hookProcessKey,
  type HookProcessVerdict,
  type HookRootEvidence
} from './hook-process-root-evidence'
import {
  attemptHookRootEvidence,
  readHookRootAttempt,
  type HookRootAcquisition,
  type HookRootCompletion
} from './hook-root-attempts'
import { readTmuxHookPane, readTmuxHookPaneHint } from './tmux-client-attachment'

export type { HookRootAcquisition, HookRootCompletion } from './hook-root-attempts'

function recordedOwner(
  previous: AgentHookEventPayload | undefined
): AgentProcessPresence | undefined {
  return previous?.providerSessionOnly ? undefined : previous?.agentPresence
}

/** A process-bearing hook acquires new authority unless the pane's owner is a live process that
 *  proved itself, so it must show it belongs to the pane's own job: into an absent or weak record,
 *  over a fallback (which a proved root replaces) or a suspended owner, and after an exit. */
export function needsHookRootEvidence(
  previous: AgentHookEventPayload | undefined,
  process: AgentProcessIdentity | undefined
): process is AgentProcessIdentity {
  const owner = recordedOwner(previous)
  if (!process) {
    return false
  }
  if (!owner?.process || owner.fallback) {
    return true
  }
  // A retired owner's own process is refused outright, never re-examined.
  return (owner.ended || owner.suspended) === true && !isSameAgentProcess(owner.process, process)
}

/** The association a late answer must still find; status-only updates leave it unchanged. */
function associationOf(previous: AgentHookEventPayload | undefined): string {
  const owner = recordedOwner(previous)
  return owner
    ? [
        owner.agent,
        owner.process ? hookProcessKey(owner.process) : '',
        owner.ended,
        owner.suspended,
        owner.fallback
      ].join('|')
    : ''
}

/** The execution host's evidence on this hook's process for the pane. Undefined keeps the legacy
 *  path: no evidence applies, or this host or endpoint cannot bind the pane's root. */
export function readHookProcessEvidence(
  state: HookListenerState,
  previous: AgentHookEventPayload | undefined,
  hook: { paneKey: string; process: AgentProcessIdentity | undefined }
): HookRootEvidence | undefined {
  if (!needsHookRootEvidence(previous, hook.process)) {
    return undefined
  }
  return readHookRootAttempt(state, hook.paneKey, hook.process)
}

export function readHookProcessVerdict(
  state: HookListenerState,
  previous: AgentHookEventPayload | undefined,
  hook: { paneKey: string; process: AgentProcessIdentity | undefined }
): HookProcessVerdict | undefined {
  return readHookProcessEvidence(state, previous, hook)?.verdict
}

/** Refuse before provider folds: the retired owner's own late hook, a process the execution host
 *  proved is nested under, competing with or foreign to the pane's agent, or any unproved process
 *  replacing a suspended owner. */
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
  const owner = recordedOwner(previous)
  const verdict = readHookProcessVerdict(state, previous, hook)
  const own = Boolean(
    hook.process && owner?.process && isSameAgentProcess(owner.process, hook.process)
  )
  const retired = own && owner?.ended === true
  // Suspension blocks a replacement, never the owner's own process resuming.
  const displacesSuspended = Boolean(
    owner?.suspended && !owner.ended && !own && verdict !== undefined
  )
  return {
    refused:
      retired ||
      verdict === 'nested' ||
      verdict === 'competing' ||
      (displacesSuspended && verdict !== 'root'),
    verdict
  }
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
    previous,
    owner: recordedOwner(previous),
    sender: { agent: source, process: readHookAgentProcess(source, envelope.record.agentProcess) }
  }
}

/** The pane's current row carrying what a late answer settles: the candidate acquires, upgrades
 *  its fallback, retires the weak record on its recorded exit, or loses a fallback it was proved
 *  not to own. Restated as a suspension change is, with no event name or prompt, so nothing
 *  replays or notifies. Undefined when a successor took the pane or the exit's record moved on. */
export function restateHookRoot(
  state: HookListenerState,
  completion: HookRootCompletion,
  exitEventName?: string
): AgentHookEventPayload | undefined {
  const { attempt, process } = completion
  const row = readLocalHookOwnerRow(
    state.lastStatusByPaneKey,
    completion.paneKey,
    completion.worktreeId
  )
  if (!row || row.payload.agentType !== completion.agent) {
    return undefined
  }
  const owner = recordedOwner(row)
  const ownFallback = Boolean(
    owner?.fallback && owner.process && isSameAgentProcess(owner.process, process)
  )
  const verdict = readHookProcessVerdict(state, row, completion)
  const exit = verdict === 'root' && attempt.exit !== undefined
  const association = associationOf(row)
  // Why: a root outranks the same unproven records late as on its next hook; a stopped or retired
  // owner, and an exit's record, must be the ones the read started against.
  const outranked =
    !owner || (!owner.ended && !owner.suspended && (owner.fallback || !owner.process))
  if (
    verdict === 'root'
      ? exit
        ? association !== attempt.exit
        : !ownFallback && !outranked && association !== attempt.association
      : !ownFallback || verdict === 'unknown' || verdict === undefined
  ) {
    return undefined
  }
  return {
    ...row,
    isReplay: undefined,
    hookEventName: exit ? exitEventName : undefined,
    hasExplicitPrompt: undefined,
    agentPresence: {
      agent: completion.agent,
      process,
      sessionOwner: true,
      ...(exit ? { ended: true as const } : {}),
      ...(ownFallback && owner?.suspended ? { suspended: true as const } : {})
    }
  }
}

/** Confirm an old owner's exit on its execution host before accepting a replacement, then read
 *  whether a process acquiring the pane belongs to its job; both settle before provider folds. */
export function checkHookOwnerPresence(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string,
  check: (paneKey: string) => Promise<unknown>,
  acquisition?: HookRootAcquisition
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
    if (!acquisition || !needsHookRootEvidence(previous, process)) {
      return undefined
    }
    const tmux =
      readTmuxHookPane(envelope.record.tmux) ?? readTmuxHookPaneHint(envelope.record.tmuxPane)
    return attemptHookRootEvidence(
      state,
      acquisition,
      {
        paneKey: envelope.paneKey,
        worktreeId: envelope.worktreeId,
        agent: source,
        process,
        ...(tmux ? { tmux } : {})
      },
      {
        eventName: envelope.eventName,
        exit: isProcessExitSessionEnd(envelope.eventName, envelope.hookPayloadRecord),
        association: associationOf(previous)
      }
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
    hook &&
    hook.owner?.agent === source &&
    hasOtherAgentProcessOwner(hook.owner, hook.sender) &&
    // A proved root replaces the owner's fallback rather than speaking as its guest.
    readHookProcessVerdict(state, hook.previous, {
      paneKey: hook.envelope.paneKey,
      process: hook.sender.process
    }) !== 'root'
  )
}
