import { agentSessionSignInCopyId } from './agent-session-availability'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'
import type {
  AgentSessionFailureWordsContext,
  AgentSessionFailureSurface
} from './agent-session-failure-words'
import { joinSentences } from './sentence-joining'
import { agentSessionSignInFor } from './agent-session-sign-in'

const SENTENCE_END = /[.!?。！？][\p{Pe}\p{Pf}"']*\s*$/u

// The sentences for a start no account or CLI on this host can make: also the chat's notice.

function agent(say: AgentSessionFailureSay, { agentName }: AgentSessionFailureWordsContext) {
  return { agent: agentName ?? say('theAgent') }
}

export function notSignedInSentence(
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  say: AgentSessionFailureSay,
  surface: AgentSessionFailureSurface = 'row'
): string {
  const signIn = agentSessionSignInFor(context.agentName ?? context.provider)
  const copy = say(signIn ? agentSessionSignInCopyId(signIn.agent, fact.account) : 'notSignedIn', {
    ...agent(say, context),
    loginCommand: signIn?.loginCommand.join(' '),
    slashCommand: signIn && 'slashCommand' in signIn ? signIn.slashCommand : undefined
  })
  const next = context.retryControl
    ? undefined
    : context.command
      ? say('runCommandAgain', { command: context.command })
      : surface === 'rejection' &&
          context.messageSubmitted !== false &&
          signIn?.agent !== 'claude' &&
          signIn?.agent !== 'codex'
        ? say(signIn ? 'thenSendAgain' : 'signInThenSend')
        : undefined
  const detail = fact.detail?.audience === 'person' ? fact.detail.text : undefined
  const detailSentence =
    detail && next && !SENTENCE_END.test(detail) ? `${detail.trimEnd()}.` : detail
  return joinSentences(
    [copy, detailSentence, next].filter((sentence): sentence is string => sentence !== undefined)
  )
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
