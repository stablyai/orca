import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import {
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  claimOutboxDispatch,
  forgetOutboxDispatch,
  transitionOutboxEntry
} from '@/components/native-chat/structured-agent-session-outbox-transitions'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  onPromptDelivered?: () => void
}

type LaunchReceipt = { sessionId: string; fence: number }

async function dispatchStructuredLaunchPrompt(
  entry: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt
): Promise<boolean> {
  const reservation = claimOutboxDispatch(entry)
  if (!reservation.changed || !reservation.entry) {
    return false
  }
  const claim = reservation.entry
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionSendResult>
    >(
      { kind: 'local' },
      'agentSession.send',
      structuredAgentSessionSendRequest(entry, receipt.fence)
    )
    if (!result.ok) {
      transitionOutboxEntry(claim, (current) =>
        requeueStructuredAgentSessionSendRefusal(current, result.refusal.code, () =>
          createStructuredAgentSessionOperationId(() => crypto.randomUUID())
        )
      )
      return false
    }
    const dispatchState = result.value.submission.dispatchState
    transitionOutboxEntry(
      claim,
      (current) =>
        dispatchState === 'accepted'
          ? null
          : {
              ...current,
              state: dispatchState === 'unknown' ? 'unconfirmed' : 'queued'
            },
      dispatchState === 'accepted'
    )
    return dispatchState === 'accepted'
  } catch {
    transitionOutboxEntry(claim, (current) => ({ ...current, state: 'unconfirmed' }))
    return false
  } finally {
    forgetOutboxDispatch(claim)
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
    const delivered = await dispatchStructuredLaunchPrompt(args.stagedEntry, receipt)
    if (delivered) {
      args.options.onPromptDelivered?.()
    }
    return { delivered, failureNotified: false }
  })
}
