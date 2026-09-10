import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import {
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../shared/structured-agent-session-outbox'
import { agentSessionRefusalOperationState } from '../../../shared/agent-session-refusal-retry'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  mutateStructuredAgentSessionLaunchPrompt,
  type StructuredAgentSessionLaunchPromptMutation
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  deliveryUnknown?: true
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready'
  onPromptDelivered?: () => void
}

type LaunchReceipt = { sessionId: string; fence: number }
type PromptDispatchOutcome = 'delivered' | 'failed' | 'unknown'

function mutateEntry(
  entry: StructuredAgentSessionOutboxEntry,
  update: StructuredAgentSessionLaunchPromptMutation
): boolean {
  return mutateStructuredAgentSessionLaunchPrompt(entry.sessionId, entry.clientMessageId, update)
}

async function dispatchStructuredLaunchPrompt(
  entry: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt,
  strict: boolean
): Promise<PromptDispatchOutcome> {
  if (
    !mutateEntry(entry, (current) => ({
      ...current,
      state: 'dispatching',
      lastAttemptAt: Date.now()
    }))
  ) {
    return 'failed'
  }
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionSendResult>
    >(
      { kind: 'local' },
      'agentSession.send',
      structuredAgentSessionSendRequest(entry, receipt.fence)
    )
    if (!result.ok) {
      const operationState = agentSessionRefusalOperationState(
        'agentSession.send',
        result.refusal.code
      )
      mutateEntry(entry, (current) => {
        if (strict) {
          return operationState === 'settled-rejected'
            ? null
            : {
                ...current,
                state: 'unconfirmed',
                // A host-unknown operation must be force-retried with its original id.
                retryAfterUnknownSubmittedAt:
                  result.refusal.code === 'agent_session_operation_unknown'
                    ? -1
                    : current.retryAfterUnknownSubmittedAt
              }
        }
        return requeueStructuredAgentSessionSendRefusal(current, result.refusal.code, () =>
          createStructuredAgentSessionOperationId(() => crypto.randomUUID())
        )
      })
      return operationState === 'settled-rejected' ? 'failed' : 'unknown'
    }
    const submission = result.value.submission
    const dispatchState = submission.dispatchState
    mutateEntry(entry, (current) =>
      dispatchState === 'accepted'
        ? null
        : strict && dispatchState === 'rejected'
          ? null
          : {
              ...current,
              state:
                dispatchState === 'unknown' || (strict && dispatchState === 'pending')
                  ? 'unconfirmed'
                  : 'queued',
              retryAfterUnknownSubmittedAt:
                strict && dispatchState === 'unknown' && typeof submission.submittedAt === 'number'
                  ? submission.submittedAt
                  : current.retryAfterUnknownSubmittedAt
            }
    )
    return dispatchState === 'accepted'
      ? 'delivered'
      : dispatchState === 'rejected'
        ? 'failed'
        : 'unknown'
  } catch {
    mutateEntry(entry, (current) => ({ ...current, state: 'unconfirmed' }))
    return 'unknown'
  }
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  options: StructuredLaunchPromptOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): Promise<StructuredPromptDeliveryResult> | undefined {
  if (!args.options.prompt?.trim()) {
    return undefined
  }
  return args.launchResult.then(async (receipt) => {
    if (!args.stagedEntry) {
      return { delivered: false, failureNotified: true }
    }
    const strict = args.options.promptDelivery === 'submit-after-ready'
    const outcome = await dispatchStructuredLaunchPrompt(args.stagedEntry, receipt, strict)
    if (outcome === 'delivered') {
      args.options.onPromptDelivered?.()
    }
    return {
      delivered: outcome === 'delivered',
      failureNotified: false,
      ...(strict && outcome === 'unknown' ? { deliveryUnknown: true as const } : {})
    }
  })
}
