// One structured-session mutation, fenced and idempotent.
//
// The client operation id is keyed on (session, method, payload) so a retry of
// the same request reuses it and the host upserts one row instead of two (a
// payload naming no target gets a new one on every call), and
// every result is discarded unless the runtime fence it was issued against is
// still the current one; the reply to the conversation command a pane still
// waits on is kept, since that command may move the fence itself. A write that
// did not happen is reported once, in the person's words, by the caller that
// knows where to say it; nothing latches.

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import * as conversationCommands from './structured-conversation-command-send'
import type { AgentSessionMutationResult } from '../../../../shared/agent-session-wire'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  agentSessionWriteKindForMethod as writeKind
} from '../../../../shared/agent-session-write-failure'
import { agentSessionRefusalOperationState } from '../../../../shared/agent-session-refusal-retry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionWriteNamesItsTarget } from '../../../../shared/structured-agent-session-operation-identity'
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
  // The conversation command this pane still waits on; only its reply may outlive a fence move. A
  // newer command replaces it, and disabling the pane forgets it.
  const commandInFlight = useRef<object | null>(null)
  useEffect(() => {
    // Why: update the gate after commit so render stays free of ref mutations.
    enabledRef.current = enabled
    commandInFlight.current = null
  }, [enabled, sessionId])

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
      const request = {}
      if (fingerprintMethod === 'agentSession.conversationCommand') {
        commandInFlight.current = request
      }
      // Whether this call's answer is still for what the pane shows. Another fence's result is about
      // a runtime the pane replaced; a conversation command may itself start or stop the agent,
      // moving the fence under its own reply, so that reply is kept while this pane still waits on
      // it. Called once, when the call settles.
      const settlesHere = (): boolean => {
        const waitedOn = commandInFlight.current === request
        if (waitedOn) {
          commandInFlight.current = null
        }
        return enabledRef.current && (stateRef.current.fence === targetFence || waitedOn)
      }
      const key = `${sessionId}:${fingerprintMethod}:${JSON.stringify(fields)}`
      // A write naming no target acts on whatever is in flight when the host reaches it, so every
      // press is its own write; one naming its target keeps its id for a retry to replay.
      const namesTarget = structuredAgentSessionWriteNamesItsTarget(fingerprintMethod, fields)
      const clientOperationId =
        operationIdOverride ??
        (namesTarget ? operationIds.current.get(key) : undefined) ??
        structuredSessionOperationId()
      if (namesTarget) {
        operationIds.current.set(key, clientOperationId)
      }
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
        return settlesHere()
          ? {
              kind: 'not-done',
              notice: agentSessionWriteFailureText(
                agentSessionThrownFailure(
                  error,
                  error instanceof RuntimeRpcCallError ? error.code : undefined
                ),
                writeKind(fingerprintMethod, fields)
              )
            }
          : { kind: 'dropped' }
      }
      if (!result.ok) {
        const operationState = agentSessionRefusalOperationState(result.refusal.code)
        // Cancel's plan recovers no unknown ledger row, so a kept id would earn the same refusal
        // until it expires, and Stop for that turn would do nothing.
        if (
          operationState === 'settled-rejected' ||
          (operationState === 'unknown' && fingerprintMethod === 'agentSession.cancel')
        ) {
          operationIds.current.delete(key)
        }
        return settlesHere()
          ? {
              kind: 'not-done',
              notice: agentSessionWriteFailureText(
                agentSessionRefusalFailure(result.refusal),
                writeKind(fingerprintMethod, fields)
              )
            }
          : { kind: 'dropped' }
      }
      if (!settlesHere()) {
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
