import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  disposeStructuredAgentSessionSendFailure,
  disposeStructuredAgentSessionSendResult,
  type StructuredAgentSessionSendDisposition
} from '../../../../shared/structured-agent-session-send-disposition'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  structuredAgentSessionSendRequest,
  updateStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import {
  getStructuredAgentLaunchPromptDispatch,
  shareStructuredAgentLaunchPromptDispatch
} from '@/lib/structured-agent-session-launch-prompt'

type MutableRef<T> = { current: T }

function isDesktopDeliveryUnknown(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  return /timeout|disconnect|connection|closed|unavailable|cutover/i.test(text)
}

export function hasInFlightLaunchDispatch(
  entry: StructuredAgentSessionOutboxEntry,
  fence: number | null
): boolean {
  return Boolean(
    entry.source === 'launch' &&
    getStructuredAgentLaunchPromptDispatch(
      entry.sessionId,
      entry.clientMessageId,
      fence ?? undefined
    )
  )
}

export function readMountedStructuredAgentSessionOutbox(
  sessionId: string,
  fence: number | null,
  read: (
    sessionId: string,
    options: { recoverDispatching: boolean }
  ) => StructuredAgentSessionOutboxEntry[]
): StructuredAgentSessionOutboxEntry[] {
  return read(sessionId, { recoverDispatching: false }).map((entry) =>
    entry.state === 'dispatching' && !hasInFlightLaunchDispatch(entry, fence)
      ? { ...entry, state: 'unconfirmed' as const }
      : entry
  )
}

export function dispatchStructuredAgentSessionOutboxEntry(args: {
  next: StructuredAgentSessionOutboxEntry
  persisted: readonly StructuredAgentSessionOutboxEntry[]
  sessionId: string
  target: RuntimeClientTarget
  fence: number
  dispatchGeneration: number
  dispatchGenerationRef: MutableRef<number>
  inFlightIdRef: MutableRef<string | null>
  blockedIdRef: MutableRef<string | null>
  outboxRef: MutableRef<StructuredAgentSessionOutboxEntry[]>
  setOutbox: (entries: StructuredAgentSessionOutboxEntry[]) => void
  setError: (error: string | null) => void
  applyDisposition: (disposition: StructuredAgentSessionSendDisposition) => void
  createOperationId: () => string
}): { promise: Promise<boolean>; started: boolean } {
  const start = async (): Promise<boolean> => {
    args.inFlightIdRef.current = args.next.clientMessageId
    const staged = updateStructuredAgentSessionOutboxEntry(
      args.persisted,
      args.next.clientMessageId,
      ({ notice: _sentAgain, ...entry }) => ({
        ...entry,
        state: 'dispatching' as const,
        lastAttemptAt: Date.now()
      })
    )
    if (!writeOutbox(args.sessionId, staged)) {
      args.inFlightIdRef.current = null
      args.blockedIdRef.current = args.next.clientMessageId
      args.setError('Message could not be saved to the outbox')
      return false
    }
    args.outboxRef.current = staged
    args.setOutbox(staged)
    // No `finally` release below: `applyDisposition` frees single-flight as part of the state
    // write that re-runs the drain, and a microtask later would leave the queue no trigger.
    try {
      const result = await callStructuredAgentSession<
        AgentSessionMutationResult<AgentSessionSendResult>
      >(args.target, 'agentSession.send', structuredAgentSessionSendRequest(args.next, args.fence))
      if (args.dispatchGenerationRef.current !== args.dispatchGeneration) {
        return false
      }
      args.applyDisposition(
        disposeStructuredAgentSessionSendResult({
          entries: args.outboxRef.current,
          entry: args.next,
          blockedClientMessageId: args.blockedIdRef.current,
          result,
          createOperationId: args.createOperationId
        })
      )
      return result.ok
        ? result.value.submission.dispatchState === 'accepted' ||
            result.value.submission.dispatchState === 'pending'
        : false
    } catch (caught) {
      if (args.dispatchGenerationRef.current !== args.dispatchGeneration) {
        return false
      }
      args.applyDisposition(
        disposeStructuredAgentSessionSendFailure({
          entries: args.outboxRef.current,
          entry: args.next,
          blockedClientMessageId: args.blockedIdRef.current,
          cause: caught,
          isDeliveryUnknown: isDesktopDeliveryUnknown
        })
      )
      return false
    }
  }
  return args.next.source === 'launch'
    ? shareStructuredAgentLaunchPromptDispatch(
        args.next.sessionId,
        args.next.clientMessageId,
        args.fence,
        start
      )
    : { promise: start(), started: true }
}
