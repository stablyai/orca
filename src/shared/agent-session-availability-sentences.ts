import { agentSessionSignInCopyId } from './agent-session-availability'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'
import { joinSentences } from './sentence-joining'

// The sentences for a start no account or CLI on this host can make: also the chat's notice.

function agent(say: AgentSessionFailureSay, { agentName }: AgentSessionFailureWordsContext) {
  return { agent: agentName ?? say('theAgent') }
}

export function notSignedInSentence(
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  say: AgentSessionFailureSay
): string {
  if (!context.provider && context.agentName !== 'Claude' && context.agentName !== 'Codex') {
    return joinSentences([
      say('notSignedIn', agent(say, context)),
      context.retryControl
        ? say('signInFirst')
        : context.command
          ? say('signInThenRunCommand', { command: context.command })
          : say('signInThenSend')
    ])
  }
  const provider =
    context.agentName === 'Codex'
      ? 'codex'
      : context.agentName === 'Claude'
        ? 'claude'
        : (context.provider ?? 'claude')
  const signIn = say(agentSessionSignInCopyId(provider, fact.account))
  // Signing in is the step; a command the start was for still has to be run again after it.
  return context.command && !context.retryControl
    ? joinSentences([signIn, say('runCommandAgain', { command: context.command })])
    : signIn
}

/** A command the start was for is still run again once the CLI is installed. */
export function cliMissingSentence(
  context: AgentSessionFailureWordsContext,
  say: AgentSessionFailureSay
): string {
  return joinSentences([
    say('cliMissing', agent(say, context)),
    ...(context.command && !context.retryControl
      ? [say('runCommandAgain', { command: context.command })]
      : [])
  ])
}
