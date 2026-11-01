import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
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
  type HookRootEvidenceReader
} from './hook-process-root-evidence'

// One entry per process that tried to acquire an unproven pane; old entries only cost a re-read.
const MAX_HOOK_PROCESS_VERDICTS = 256

/** A process-bearing hook into a row whose owner proves no live process must show it is the
 *  pane's own agent. A fresh pane or a launch seed has no association to displace. */
export function needsHookRootEvidence(
  previous: AgentHookEventPayload | undefined,
  process: AgentProcessIdentity | undefined
): process is AgentProcessIdentity {
  const owner = previous?.agentPresence
  return Boolean(
    process &&
    previous &&
    !previous.providerSessionOnly &&
    // A retired owner's own process is refused outright, never re-examined.
    !(owner?.process && (!owner.ended || isSameAgentProcess(owner.process, process)))
  )
}

/** The execution host's verdict on this hook's process, where it applies to the pane's row. */
export function readHookProcessVerdict(
  state: HookListenerState,
  previous: AgentHookEventPayload | undefined,
  process: AgentProcessIdentity | undefined
): HookProcessVerdict | undefined {
  return needsHookRootEvidence(previous, process)
    ? state.hookProcessVerdicts.get(hookProcessKey(process))
    : undefined
}

/** Refuse before provider folds: the retired owner's own late hook, or a process the execution
 *  host proved is nested under or competing with the pane's agent. */
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
  const verdict = readHookProcessVerdict(state, previous, hook.process)
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
):
  | {
      paneKey: string
      previous: AgentHookEventPayload
      owner: AgentProcessPresence | undefined
      sender: { agent: AgentHookSource; process?: AgentProcessIdentity }
    }
  | undefined {
  const envelope = parseHookEnvelope(state, source, body, env)
  if (!envelope) {
    return undefined
  }
  const previous = readLocalHookOwnerRow(
    state.lastStatusByPaneKey,
    envelope.paneKey,
    envelope.worktreeId
  )
  if (!previous || previous.providerSessionOnly) {
    return undefined
  }
  return {
    paneKey: envelope.paneKey,
    previous,
    owner: previous.agentPresence,
    sender: { agent: source, process: readHookAgentProcess(source, envelope.record.agentProcess) }
  }
}

/** Confirm an old owner's exit on its execution host before accepting a replacement, or read
 *  whether an unproven pane's new process is its root; both settle before provider folds run. */
export function checkHookOwnerPresence(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string,
  check: (paneKey: string) => Promise<unknown>,
  readRootEvidence?: HookRootEvidenceReader
): Promise<unknown> | undefined {
  const hook = readHookPaneOwner(state, source, body, env)
  // A suspended owner may have resumed without emitting another hook.
  if (
    hook &&
    hasOtherAgentProcessOwner(hook.owner && { ...hook.owner, suspended: undefined }, hook.sender)
  ) {
    return check(hook.paneKey)
  }
  const process = hook?.sender.process
  if (!hook || !readRootEvidence || !needsHookRootEvidence(hook.previous, process)) {
    return undefined
  }
  const key = hookProcessKey(process)
  const known = state.hookProcessVerdicts.get(key)
  // Lineage outlives the attempt; foreground and unreadable answers can change by the next hook.
  if (known === 'root' || known === 'nested') {
    return undefined
  }
  return readRootEvidence(process).then((verdict) => {
    const verdicts = state.hookProcessVerdicts
    verdicts.delete(key)
    verdicts.set(key, verdict)
    for (const oldest of verdicts.keys()) {
      if (verdicts.size <= MAX_HOOK_PROCESS_VERDICTS) {
        break
      }
      verdicts.delete(oldest)
    }
  })
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
