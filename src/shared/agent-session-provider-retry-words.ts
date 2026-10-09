// The words for a provider retry: which retry it is and what last failed, from the provider's
// own fields, for a provider that wrote none of its own for a person.

import type { AgentSessionProviderRetry } from './agent-session-failure'
import type {
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from './agent-session-failure-copy'
import { joinSentences } from './sentence-joining'
import { isProviderDiagnosticPersonText } from './provider-diagnostic-person-text'

/** The provider's account of what failed goes on the line under the sentence, as it wrote it. */
export function withRetryCause(sentence: string, cause: string | undefined): string {
  return cause && isProviderDiagnosticPersonText(cause) ? `${sentence}\n${cause}` : sentence
}

export function providerRetryWords(
  say: AgentSessionFailureSay,
  agent: AgentSessionFailureCopyValues,
  retry: AgentSessionProviderRetry | undefined
): string {
  return withRetryCause(
    joinSentences([
      say(
        retry?.error === 'rate_limit' || retry?.status === 429
          ? 'providerRateLimited'
          : 'providerRetrying',
        agent
      ),
      ...retryNumber(say, retry)
    ]),
    retry?.cause
  )
}

function retryNumber(
  say: AgentSessionFailureSay,
  retry: AgentSessionProviderRetry | undefined
): string[] {
  if (!retry?.attempt) {
    return []
  }
  const attempt = String(retry.attempt)
  return [
    retry.maxRetries
      ? say('providerRetryNumberOf', { attempt, maxRetries: String(retry.maxRetries) })
      : say('providerRetryNumber', { attempt })
  ]
}
