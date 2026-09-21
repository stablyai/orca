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
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

type LaunchReceipt = { sessionId: string; fence: number }

type SharedDispatchStart = {
  promise: Promise<boolean>
  started: boolean
}

// A provisional chat can mount before its launch settlement runs. Both paths own the same
// persisted entry, so share the in-flight admission by operation id instead of issuing two RPCs.
const inFlightDispatches = new Map<string, Promise<boolean>>()

function dispatchKey(sessionId: string, clientMessageId: string, fence: number): string {
  return `${sessionId}:${clientMessageId}:${fence}`
}

export function getStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence?: number
): Promise<boolean> | undefined {
  if (fence !== undefined) {
    return inFlightDispatches.get(dispatchKey(sessionId, clientMessageId, fence))
  }
  const prefix = `${sessionId}:${clientMessageId}:`
  for (const [key, promise] of inFlightDispatches) {
    if (key.startsWith(prefix)) {
      return promise
    }
  }
  return undefined
}

export function shareStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence: number,
  start: () => Promise<boolean>
): SharedDispatchStart {
  const key = dispatchKey(sessionId, clientMessageId, fence)
  const existing = inFlightDispatches.get(key)
  if (existing) {
    return { promise: existing, started: false }
  }
  const promise = Promise.resolve().then(start)
  inFlightDispatches.set(key, promise)
  const clear = (): void => {
    if (inFlightDispatches.get(key) === promise) {
      inFlightDispatches.delete(key)
    }
  }
  void promise.then(clear, clear)
  return { promise, started: true }
}

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
        requeueStructuredAgentSessionSendRefusal(
          current,
          result.refusal.code,
          () => createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
          entry.lastAttemptAt !== null
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
            state:
              dispatchState === 'unknown'
                ? 'unconfirmed'
                : dispatchState === 'pending'
                  ? 'dispatching'
                  : 'queued'
          }
    )
    return dispatchState === 'accepted' || dispatchState === 'pending'
  } catch {
    mutateEntry(entry, (current) => ({ ...current, state: 'unconfirmed' }))
    return false
  }
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  options: StructuredLaunchPromptOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): Promise<StructuredPromptDeliveryResult> | undefined {
  // Why: a draft has no delivery event — the composer adopts it and the user sends it — so
  // `onPromptDelivered` never fires and no result is reported.
  if (args.options.promptDelivery === 'draft' || !args.options.prompt?.trim()) {
    return undefined
  }
  return args.launchResult.then(async (receipt) => {
    if (!args.stagedEntry) {
      return { delivered: false, failureNotified: true }
    }
    const entry = args.stagedEntry
    const dispatch = shareStructuredAgentLaunchPromptDispatch(
      entry.sessionId,
      entry.clientMessageId,
      receipt.fence,
      () => dispatchStructuredLaunchPrompt(entry, receipt)
    )
    const delivered = await dispatch.promise
    if (delivered) {
      args.options.onPromptDelivered?.()
    }
    return { delivered, failureNotified: false }
  })
}
