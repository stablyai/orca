// The failed start's refusal and host-composed authentication guidance.

import {
  readAgentSessionRefusalReference,
  type AgentSessionRefusalReference
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionConversationOwner } from '../../../shared/agent-session-refusal-details'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteRefusal
} from '../../../shared/agent-session-write-failure'
import { translate } from '@/i18n/i18n'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'

export type StructuredLaunchFailure = AgentSessionWriteRefusal & {
  /** Words that replace the refusal's generic cause: the host's sign-in guidance, or why this
   *  workspace can't run the chat. */
  causeText?: string
  owner?: AgentSessionConversationOwner
}

/** Why a host said it can't run a chat in this workspace, and what to do instead. */
export function structuredChatUnavailableText(reason?: string): string {
  return reason === 'wsl'
    ? translate(
        'components.native-chat.explicitChatWsl',
        'Chat is not available in WSL. Open the agent in a terminal instead.'
      )
    : reason === 'remote'
      ? translate(
          'components.native-chat.explicitChatSsh',
          'Chat is not available over SSH. Open the agent in a terminal instead.'
        )
      : translate(
          'components.native-chat.explicitChatUnavailable',
          'This workspace cannot run the chat. Check the agent installation or open it in a terminal.'
        )
}

/** The host's refusal behind a failed launch; undefined when the failure carried none. */
export function structuredLaunchFailure(error: unknown): StructuredLaunchFailure | undefined {
  if (error instanceof StructuredAgentSessionCreateRefusalError && error.hostReason) {
    return {
      kind: 'refused',
      code: 'structured_agent_session_unsupported',
      causeText: structuredChatUnavailableText(error.hostReason)
    }
  }
  const refusal = launchRefusal(error)
  if (!refusal) {
    return undefined
  }
  const owner =
    refusal.code === 'agent_session_conflict' || refusal.code === 'agent_session_ownership_unknown'
      ? refusal.details?.owner
      : undefined
  const failure = {
    ...agentSessionRefusalFailure(refusal),
    ...(owner ? { owner } : {})
  }
  const message = error instanceof Error ? error.message : undefined
  return failure.code === 'agent_session_operation_invalid' &&
    failure.details?.reason === 'notSignedIn' &&
    message &&
    message !== failure.code
    ? { ...failure, causeText: message }
    : failure
}

/** The chat a refused takeover names as already holding the conversation: the host's ownership
 *  index, which a write failure does not keep. */
export function structuredLaunchConversationOwner(
  error: unknown
): AgentSessionConversationOwner | undefined {
  const details = launchRefusal(error)?.details
  return details && 'owner' in details ? details.owner : undefined
}

function launchRefusal(error: unknown): AgentSessionRefusalReference | undefined {
  return error instanceof Error && 'refusal' in error
    ? readAgentSessionRefusalReference(error.refusal)
    : readAgentSessionErrorRefusal(error)
}
