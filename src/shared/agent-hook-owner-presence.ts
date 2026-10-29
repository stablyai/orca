import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import type { AgentHookSource } from './agent-hook-relay'
import {
  hasOtherAgentProcessOwner,
  readHookAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from './agent-process-presence'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'

function readHookPaneOwner(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string
):
  | {
      paneKey: string
      owner: AgentProcessPresence | undefined
      sender: { agent: AgentHookSource; process?: AgentProcessIdentity }
    }
  | undefined {
  const envelope = parseHookEnvelope(state, source, body, env)
  if (!envelope) {
    return undefined
  }
  const previous = state.lastStatusByPaneKey.get(envelope.paneKey)
  if (
    !previous ||
    previous.providerSessionOnly ||
    !sameAgentStatusTerminalOwner(
      { connectionId: previous.connectionId ?? null, worktreeId: previous.worktreeId },
      { connectionId: null, worktreeId: envelope.worktreeId }
    )
  ) {
    return undefined
  }
  return {
    paneKey: envelope.paneKey,
    owner: previous.agentPresence,
    sender: { agent: source, process: readHookAgentProcess(source, envelope.record.agentProcess) }
  }
}

/** Confirm an old owner's exit on its execution host before accepting a replacement. */
export function checkHookOwnerPresence(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string,
  check: (paneKey: string) => Promise<unknown>
): Promise<unknown> | undefined {
  const hook = readHookPaneOwner(state, source, body, env)
  // A suspended owner may have resumed without emitting another hook.
  if (
    hook &&
    hasOtherAgentProcessOwner(hook.owner && { ...hook.owner, suspended: undefined }, hook.sender)
  ) {
    return check(hook.paneKey)
  }
  return undefined
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
