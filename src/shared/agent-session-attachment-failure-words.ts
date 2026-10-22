// The words for an attachment a message could not carry: which check it failed, and the limit.

import type {
  AgentSessionAttachmentProblem,
  AgentSessionAttachmentProblemReason
} from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'

const BYTES_PER_MB = 1024 * 1024

function agent(say: AgentSessionFailureSay, { agentName }: AgentSessionFailureWordsContext) {
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

export function attachmentProblemSentence(
  say: AgentSessionFailureSay,
  context: AgentSessionFailureWordsContext,
  problem: AgentSessionAttachmentProblem
): string {
  return ATTACHMENT_SENTENCES[problem.reason](say, context, problem)
}
