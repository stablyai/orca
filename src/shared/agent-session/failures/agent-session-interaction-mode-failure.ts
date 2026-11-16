import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'
import type {
  AgentSessionFailureSurface,
  AgentSessionFailureWordsContext
} from './agent-session-failure-words'
import { agent } from './agent-session-attachment-failure-words'

export type AgentSessionInteractionModeFailure = {
  mode: 'default' | 'plan'
  problem: 'unavailable' | 'unconfirmed' | 'failed'
}

export function readInteractionModeFailure(
  value: unknown
): AgentSessionInteractionModeFailure | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'mode' in value &&
    'problem' in value &&
    (value.mode === 'default' || value.mode === 'plan') &&
    (value.problem === 'unavailable' ||
      value.problem === 'unconfirmed' ||
      value.problem === 'failed')
    ? { mode: value.mode, problem: value.problem }
    : undefined
}

export function interactionModeFailureSentence(
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  _surface: AgentSessionFailureSurface,
  say: AgentSessionFailureSay
): string {
  const failure = fact.interactionMode
  return failure
    ? say(
        failure.problem === 'unavailable'
          ? 'interactionModeUnavailable'
          : failure.problem === 'unconfirmed'
            ? 'interactionModeUnconfirmed'
            : 'interactionModeFailed',
        { ...agent(say, context), mode: failure.mode === 'default' ? 'Build' : 'Plan' }
      )
    : say('providerRejected', agent(say, context))
}
