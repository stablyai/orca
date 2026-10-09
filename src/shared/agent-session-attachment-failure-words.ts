import type {
  AgentSessionAttachmentProblem,
  AgentSessionAttachmentProblemReason
} from './agent-session-failure'
import type {
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from './agent-session-failure-copy'

const BYTES_PER_MB = 1024 * 1024

// The number only; each language's sentence carries its own unit.
function megabytes(bytes: number): string {
  return String(Math.round((bytes / BYTES_PER_MB) * 10) / 10)
}

const ATTACHMENT_SENTENCES = {
  empty: (say) => say('attachmentEmpty'),
  tooLarge: (say, _, { limit }) =>
    limit ? say('attachmentLargerThan', { size: megabytes(limit) }) : say('attachmentTooLarge'),
  tooMany: (say, agent, { limit }) =>
    limit ? say('attachmentAtMost', { ...agent, limit: String(limit) }) : say('attachmentTooMany'),
  totalTooLarge: (say, _, { limit }) =>
    limit
      ? say('attachmentTotalMoreThan', { size: megabytes(limit) })
      : say('attachmentTotalTooLarge'),
  unsupportedType: (say, agent) => say('attachmentUnsupportedType', agent),
  notAFile: (say) => say('attachmentNotAFile'),
  noSource: (say) => say('attachmentNoSource')
} satisfies Record<
  AgentSessionAttachmentProblemReason,
  (
    say: AgentSessionFailureSay,
    agent: AgentSessionFailureCopyValues,
    problem: AgentSessionAttachmentProblem
  ) => string
>

export function agentSessionAttachmentFailureWords(
  problem: AgentSessionAttachmentProblem | undefined,
  agent: AgentSessionFailureCopyValues,
  say: AgentSessionFailureSay
): string {
  return problem
    ? ATTACHMENT_SENTENCES[problem.reason](say, agent, problem)
    : say('attachmentInvalid')
}
