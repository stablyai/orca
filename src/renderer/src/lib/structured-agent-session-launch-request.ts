import type { StagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import type { AgentLaunchRequestId } from './agent-launch-request-id'

/** What a new start brings: the user action it serves, whether it carries text, and the tab group
 *  it opens in. */
export type StructuredLaunchRequest = {
  id: AgentLaunchRequestId
  hasText: boolean
  groupId?: string
}

/** A new start's own create keeps its request and the text it staged; a Retry or re-check of an
 *  existing chat is no request of its own. */
export type StructuredLaunchAttempt =
  | {
      kind: 'first'
      requestId: AgentLaunchRequestId
      /** The request carried no text: the chat is blank until something claims it. */
      blank: boolean
      stagedPrompt: StagedStructuredLaunchPrompt | null
    }
  | { kind: 'retry' }

export function structuredLaunchRequest(options: {
  requestId: AgentLaunchRequestId
  prompt?: string
  targetGroupId?: string
}): StructuredLaunchRequest {
  return {
    id: options.requestId,
    hasText: (options.prompt?.trim() ?? '') !== '',
    ...(options.targetGroupId ? { groupId: options.targetGroupId } : {})
  }
}

/** The first attempt `requestId` re-delivers, whose text is already staged or seeded. */
export function repeatedStructuredLaunchAttempt(
  attempt: StructuredLaunchAttempt,
  requestId: AgentLaunchRequestId
): Extract<StructuredLaunchAttempt, { kind: 'first' }> | undefined {
  return attempt.kind === 'first' && attempt.requestId === requestId ? attempt : undefined
}
