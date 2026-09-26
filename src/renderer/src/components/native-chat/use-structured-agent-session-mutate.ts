// One structured-session mutation, fenced and idempotent.
//
// The client operation id is keyed on (session, method, payload) so a retry of
// the same request reuses it and the host upserts one row instead of two, and
// every result is discarded unless the runtime fence it was issued against is
// still the current one. A write that did not happen is reported once, in the
// person's words, by the caller that knows where to say it; nothing latches.

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import * as conversationCommands from './structured-conversation-command-send'
import type { AgentSessionMutationResult } from '../../../../shared/agent-session-wire'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  agentSessionWriteKindForMethod as writeKind
} from '../../../../shared/agent-session-refusal-notice'
import { agentSessionRefusalOperationState } from '../../../../shared/agent-session-refusal-retry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredSessionOperationId } from './use-structured-agent-session-outbox'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'

export type StructuredAgentSessionWriteOutcome<T> =
  | { kind: 'done'; value: T }
  /** Refused or failed, with what to tell the person. */
  | { kind: 'not-done'; notice: string }
  /** Settled for an owner or session this pane no longer shows; there is nothing to say. */
  | { kind: 'dropped' }

type WriteArgs = [
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>,
  operationIdOverride?: string | null
]

export type StructuredAgentSessionWrite = <T>(
  ...args: WriteArgs
) => Promise<StructuredAgentSessionWriteOutcome<T>>

/** A write whose failure is shown as a toast; the control that sent it is the way to try again. */
export type StructuredAgentSessionMutate = <T>(...args: WriteArgs) => Promise<T | null>

export function useStructuredAgentSessionMutate(args: {
  sessionId: string
  target: RuntimeClientTarget
  enabled?: boolean
  /** Read at settle time, not at call time: the fence can move while a request
   *  is in flight, and a result from the previous fence is not this session's. */
  stateRef: { current: { fence: number | null } }
}): {
  write: StructuredAgentSessionWrite
  mutate: StructuredAgentSessionMutate
} {
  const { enabled = true, sessionId, stateRef, target } = args
  const operationIds = useRef(new Map<string, string>())
  const enabledRef = useRef(enabled)
  useEffect(() => {
    // Why: update the gate after commit so render stays free of ref mutations.
    enabledRef.current = enabled
  }, [enabled])

  const write = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      operationIdOverride?: string | null
    ): Promise<StructuredAgentSessionWriteOutcome<T>> => {
      if (!enabled || !enabledRef.current || stateRef.current.fence === null) {
        return { kind: 'dropped' }
      }
      const targetFence = stateRef.current.fence
      const key = `${sessionId}:${fingerprintMethod}:${JSON.stringify(fields)}`
      const clientOperationId =
        operationIdOverride ?? operationIds.current.get(key) ?? structuredSessionOperationId()
      operationIds.current.set(key, clientOperationId)
      let result: AgentSessionMutationResult<T>
      try {
        result = await callStructuredAgentSession<AgentSessionMutationResult<T>>(target, method, {
          envelope: {
            sessionId,
            clientOperationId,
            expectedRuntimeFence: targetFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
      } catch (error) {
        return enabledRef.current && stateRef.current.fence === targetFence
          ? {
              kind: 'not-done',
              notice: agentSessionWriteFailureText(
                agentSessionRpcErrorFailure(
                  error instanceof RuntimeRpcCallError ? error.code : undefined
                ),
                writeKind(fingerprintMethod)
              )
            }
          : { kind: 'dropped' }
      }
      if (!result.ok) {
        if (agentSessionRefusalOperationState(result.refusal.code) === 'settled-rejected') {
          operationIds.current.delete(key)
        }
        return enabledRef.current && stateRef.current.fence === targetFence
          ? {
              kind: 'not-done',
              notice: agentSessionWriteFailureText(
                agentSessionRefusalFailure(result.refusal),
                writeKind(fingerprintMethod)
              )
            }
          : { kind: 'dropped' }
      }
      if (!enabledRef.current || stateRef.current.fence !== targetFence) {
        return { kind: 'dropped' }
      }
      if (!conversationCommands.isUnconfirmedConversationCommand(fingerprintMethod, result.value)) {
        operationIds.current.delete(key)
      }
      return { kind: 'done', value: result.value }
    },
    [enabled, sessionId, stateRef, target]
  )

  const mutate = useCallback(
    async <T>(...writeArgs: WriteArgs): Promise<T | null> => {
      const outcome = await write<T>(...writeArgs)
      if (outcome.kind === 'not-done') {
        toast.error(outcome.notice)
      }
      return outcome.kind === 'done' ? outcome.value : null
    },
    [write]
  )

  return { write, mutate }
}
