import type {
  AgentSessionAttachmentProblem,
  AgentSessionAttachmentProblemReason
} from './agent-session-failure'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'
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

export function formatAttachmentSize(bytes: number, limit?: number): string {
  const mb = bytes / BYTES_PER_MB
  const rounded = Math.round(mb * 10) / 10
  if (
    limit !== undefined &&
    bytes > limit &&
    rounded <= Math.round((limit / BYTES_PER_MB) * 10) / 10
  ) {
    return String(Math.ceil(mb * 10) / 10)
  }
  return String(rounded)
}

export function attachmentItemLabel(problem: AgentSessionAttachmentProblem): string | undefined {
  const sizeText =
    problem.size !== undefined
      ? `${formatAttachmentSize(problem.size, problem.limit)} MB`
      : undefined
  if (problem.index !== undefined) {
    const details = [problem.name, sizeText].filter(Boolean).join(', ')
    return details ? `#${problem.index} (${details})` : `#${problem.index}`
  }
  if (problem.name && sizeText) {
    return `${problem.name} (${sizeText})`
  }
  if (problem.name) {
    return problem.name
  }
  if (sizeText) {
    return `(${sizeText})`
  }
  return undefined
}

const ATTACHMENT_SENTENCES = {
  empty: (say, _, problem) => {
    const item = attachmentItemLabel(problem)
    return item ? say('attachmentItemEmpty', { item }) : say('attachmentEmpty')
  },
  tooLarge: (say, _, problem) => {
    const item = attachmentItemLabel(problem)
    if (item) {
      return problem.limit
        ? say('attachmentItemLargerThan', { item, size: megabytes(problem.limit) })
        : say('attachmentItemTooLarge', { item })
    }
    return problem.limit
      ? say('attachmentLargerThan', { size: megabytes(problem.limit) })
      : say('attachmentTooLarge')
  },
  tooMany: (say, context, { limit }) =>
    limit
      ? say('attachmentAtMost', { ...agent(say, context), limit: String(limit) })
      : say('attachmentTooMany'),
  totalTooLarge: (say, _, { limit }) =>
    limit
      ? say('attachmentTotalMoreThan', { size: megabytes(limit) })
      : say('attachmentTotalTooLarge'),
  unsupportedType: (say, context, problem) => {
    const item = attachmentItemLabel(problem)
    return item
      ? say('attachmentItemUnsupportedType', { ...agent(say, context), item })
      : say('attachmentUnsupportedType', agent(say, context))
  },
  notAFile: (say, _, problem) => {
    const item = attachmentItemLabel(problem)
    return item ? say('attachmentItemNotAFile', { item }) : say('attachmentNotAFile')
  },
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
