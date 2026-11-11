import type { StagedStructuredLaunchPrompt } from './structured-agent-session-staged-prompt'
import type { AgentLaunchRequestId } from './routing/agent-launch-request-id'

/** A new start's own create keeps its request and the text it staged; a Retry or re-check of an
 *  existing chat is no request of its own. */
export type StructuredLaunchAttempt =
  | {
      kind: 'first'
      requestId: AgentLaunchRequestId
      stagedPrompt: StagedStructuredLaunchPrompt | null
    }
  | { kind: 'retry'; requestId?: AgentLaunchRequestId }

/** The first attempt `requestId` re-delivers, whose text is already staged or seeded. */
export function repeatedStructuredLaunchAttempt(
  attempt: StructuredLaunchAttempt,
  requestId: AgentLaunchRequestId
): { stagedPrompt: StagedStructuredLaunchPrompt | null } | undefined {
  return attempt.requestId === requestId
    ? { stagedPrompt: attempt.kind === 'first' ? attempt.stagedPrompt : null }
    : undefined
}
