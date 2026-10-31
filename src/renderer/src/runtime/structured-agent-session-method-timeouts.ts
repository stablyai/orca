import { AGENT_SESSION_SWITCH_CLIENT_MS } from '../../../shared/agent-session-switch-execution'
import { AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS } from '../../../shared/agent-session/agent-session-conversation-command'

export const STRUCTURED_AGENT_SESSION_METHOD_TIMEOUT_MS: ReadonlyMap<string, number> = new Map([
  ['agentSession.conversationCommand', AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS],
  // The host may start an agent at rest before rewinding it, as it does for a command.
  ['agentSession.rewind', 195_000],
  // Waiting model catalogs can take Claude’s 60s listing plus 15s account switch and 5s login environment.
  ['agentSession.modelCatalog', 90_000],
  ['agentSession.sleepWorkspace', 120_000],
  // All bounded-concurrency provider starts and dispatch settlements precede the reply.
  ['agentSession.restartContinue', 600_000]
])

export function structuredAgentSessionMethodTimeoutMs(
  method: string,
  params: unknown
): number | undefined {
  const executionSwitch =
    (method === 'agentSession.switchToChat' || method === 'agentSession.switchToTerminal') &&
    params !== null &&
    typeof params === 'object' &&
    'execution' in params &&
    Boolean(params.execution)
  return executionSwitch
    ? AGENT_SESSION_SWITCH_CLIENT_MS
    : STRUCTURED_AGENT_SESSION_METHOD_TIMEOUT_MS.get(method)
}
