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
  mutateStructuredAgentSessionLaunchPrompt,
  type StructuredAgentSessionLaunchPromptMutation
} from '@/components/native-chat/structured-agent-session-outbox-storage'
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

function mutateEntry(
  entry: StructuredAgentSessionOutboxEntry,
  update: StructuredAgentSessionLaunchPromptMutation
): boolean {
  return mutateStructuredAgentSessionLaunchPrompt(entry.sessionId, entry.clientMessageId, update)
}

async function dispatchStructuredLaunchPrompt(
  entry: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt
): Promise<boolean> {
  if (
    !mutateEntry(entry, (current) => ({
      ...current,
      state: 'dispatching',
      lastAttemptAt: Date.now()
    }))
  ) {
    return false
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
      mutateEntry(entry, (current) =>
        requeueStructuredAgentSessionSendRefusal(current, result.refusal.code, () =>
          createStructuredAgentSessionOperationId(() => crypto.randomUUID())
        )
      )
      return false
    }
    const dispatchState = result.value.submission.dispatchState
    mutateEntry(entry, (current) =>
      dispatchState === 'accepted'
        ? null
        : {
            ...current,
            state: dispatchState === 'unknown' ? 'unconfirmed' : 'queued'
          }
    )
    return dispatchState === 'accepted'
  } catch {
    mutateEntry(entry, (current) => ({ ...current, state: 'unconfirmed' }))
    return false
  }
}

export function settleStructuredCodexLaunchPrompt(args: {
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
