import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import type { AgentHookSource } from './agent-hook-relay'
import { hasOtherAgentProcessOwner } from './agent-process-presence'
import { sameAgentStatusTerminalOwner } from './agent-status-terminal-owner'

/** Confirm an old owner's exit on its execution host before accepting a replacement. */
export function checkHookOwnerPresence(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string,
  check: (paneKey: string) => Promise<unknown>
): Promise<unknown> | undefined {
  const envelope = parseHookEnvelope(state, source, body, env)
  if (!envelope) {
    return
  }
  const previous = state.lastStatusByPaneKey.get(envelope.paneKey)
  // A suspended owner may have resumed without emitting another hook.
  const presence = previous?.agentPresence
  if (
    previous &&
    !previous.providerSessionOnly &&
    sameAgentStatusTerminalOwner(
      { connectionId: previous.connectionId ?? null, worktreeId: previous.worktreeId },
      { connectionId: null, worktreeId: envelope.worktreeId }
    ) &&
    hasOtherAgentProcessOwner(presence && { ...presence, suspended: undefined }, source)
  ) {
    return check(envelope.paneKey)
  }
  return undefined
}
