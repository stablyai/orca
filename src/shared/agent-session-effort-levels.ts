import type { AgentSessionModelOption } from './agent-session-wire'

/** Unknown metadata admits a scalar; an explicit empty menu admits none. */
export function agentSessionEffortLevels(
  model: Pick<AgentSessionModelOption, 'efforts' | 'effortsKnown'> | undefined
): ReadonlySet<string> | null {
  return !model || model.effortsKnown === false
    ? null
    : new Set(model.efforts.map((choice) => choice.value))
}
