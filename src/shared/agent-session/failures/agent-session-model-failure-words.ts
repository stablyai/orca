import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'
import type {
  AgentSessionFailureSurface,
  AgentSessionFailureWordsContext
} from './agent-session-failure-words'
import { agent } from './agent-session-attachment-failure-words'

export function modelUnavailableSentence(
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  _surface: AgentSessionFailureSurface,
  say: AgentSessionFailureSay
): string {
  const words = { ...agent(say, context), detail: fact.detail?.text ?? say('selectedModel') }
  return fact.agentUpdate
    ? say('modelUnavailableUpdate', { ...words, minimumVersion: fact.agentUpdate })
    : say('modelUnavailable', words)
}
