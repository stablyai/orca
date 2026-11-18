import type {
  AgentSessionAttachmentProblem,
  AgentSessionAttachmentProblemReason
} from './agent-session-failure'
import {
  sayAgentSessionFailureEnglish,
  type AgentSessionFailureSay
} from './agent-session-failure-copy'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'

const BYTES_PER_MB = 1024 * 1024

/** The explicit agent name or translated fallback used in failure sentence values. */
export function agent(say: AgentSessionFailureSay, { agentName }: AgentSessionFailureWordsContext) {
  return { agent: agentName ?? say('theAgent') }
}

// The number only; each language's sentence carries its own unit.
function megabytes(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_MB) * 10) / 10)
}

const ATTACHMENT_SENTENCES = {
  empty: (say) => say('attachmentEmpty'),
  tooLarge: (say, _, { limit }) =>
    limit ? say('attachmentLargerThan', { size: megabytes(limit) }) : say('attachmentTooLarge'),
  tooMany: (say, context, { limit }) =>
    limit
      ? say('attachmentAtMost', { ...agent(say, context), limit: String(limit) })
      : say('attachmentTooMany'),
  totalTooLarge: (say, _, { limit }) =>
    limit
      ? say('attachmentTotalMoreThan', { size: megabytes(limit) })
      : say('attachmentTotalTooLarge'),
  unsupportedType: (say, context) => say('attachmentUnsupportedType', agent(say, context)),
  notAFile: (say) => say('attachmentNotAFile'),
  noSource: (say) => say('attachmentNoSource')
} satisfies Record<
  AgentSessionAttachmentProblemReason,
  (
    say: AgentSessionFailureSay,
    context: AgentSessionFailureWordsContext,
    problem: AgentSessionAttachmentProblem
  ) => string
>

/** A long list stops short: every one of them has to go, and the next refusal names the rest. */
const EXPIRED_NAMES_SHOWN = 3

export function expiredAttachmentsSentence(
  names: readonly string[],
  say: AgentSessionFailureSay = sayAgentSessionFailureEnglish
): string {
  const shown = names.slice(0, EXPIRED_NAMES_SHOWN).join(', ')
  return say('attachmentsExpired', {
    names: names.length > EXPIRED_NAMES_SHOWN ? `${shown}…` : shown
  })
}

export function attachmentProblemSentence(
  say: AgentSessionFailureSay,
  context: AgentSessionFailureWordsContext,
  problem: AgentSessionAttachmentProblem
): string {
  return ATTACHMENT_SENTENCES[problem.reason](say, context, problem)
}
