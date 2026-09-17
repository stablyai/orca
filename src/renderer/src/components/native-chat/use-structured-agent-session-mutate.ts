// One structured-session mutation, fenced and idempotent.
//
// The client operation id is keyed on (session, method, payload) so a retry of
// the same request reuses it and the host upserts one row instead of two, and
// every result is discarded unless the runtime fence it was issued against is
// still the current one.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isUnconfirmedConversationCommand } from './structured-conversation-command-claim'
import type { AgentSessionMutationResult } from '../../../../shared/agent-session-wire'
import { agentSessionRefusalOperationState } from '../../../../shared/agent-session-refusal-retry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredSessionOperationId } from './use-structured-agent-session-outbox'

export type StructuredAgentSessionMutateOptions = {
  operationId?: string
}

export type StructuredAgentSessionMutationDisposition<T> =
  | { status: 'completed'; value: T }
  | { status: 'refused'; message: string | null }
  | { status: 'unresolved'; message: string }

export type StructuredAgentSessionMutate = <T>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>,
  options?: StructuredAgentSessionMutateOptions
) => Promise<T | null>

export type StructuredAgentSessionMutateWithDisposition = <T>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>,
  options?: StructuredAgentSessionMutateOptions
) => Promise<StructuredAgentSessionMutationDisposition<T>>

export function structuredAgentSessionMutationScope(
  target: RuntimeClientTarget,
  sessionId: string
): string {
  return JSON.stringify([
    target.kind,
    target.kind === 'environment' ? target.environmentId : null,
    sessionId
  ])
}

export function useStructuredAgentSessionMutate(args: {
  sessionId: string
  target: RuntimeClientTarget
  enabled?: boolean
  /** Read at settle time, not at call time: the fence can move while a request
   *  is in flight, and a result from the previous fence is not this session's. */
  stateRef: { current: { fence: number | null } }
}): {
  mutate: StructuredAgentSessionMutate
  mutateWithDisposition: StructuredAgentSessionMutateWithDisposition
  writeError: string | null
  clearWriteError: (operationId: string) => void
} {
  const { enabled = true, sessionId, stateRef, target } = args
  const [writeError, setWriteError] = useState<string | null>(null)
  const writeErrorOwner = useRef<{ operationId: string; sequence: number } | null>(null)
  const nextMutationSequence = useRef(0)
  const latestSettledSequence = useRef(0)
  const operationIds = useRef(new Map<string, string>())
  const enabledRef = useRef(enabled)
  const requestScope = structuredAgentSessionMutationScope(target, sessionId)
  const requestScopeRef = useRef(requestScope)
  useEffect(() => {
    // Why: update the gate after commit so render stays free of ref mutations.
    enabledRef.current = enabled
  }, [enabled])
  useLayoutEffect(() => {
    requestScopeRef.current = requestScope
    operationIds.current.clear()
    writeErrorOwner.current = null
    latestSettledSequence.current = nextMutationSequence.current
    setWriteError(null)
  }, [requestScope])

  const mutateWithDisposition = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      options?: StructuredAgentSessionMutateOptions
    ): Promise<StructuredAgentSessionMutationDisposition<T>> => {
      if (!enabled || !enabledRef.current || stateRef.current.fence === null) {
        return { status: 'refused', message: null }
      }
      const targetFence = stateRef.current.fence
      const key = `${sessionId}:${fingerprintMethod}:${JSON.stringify(fields)}`
      const clientOperationId =
        options?.operationId ?? operationIds.current.get(key) ?? structuredSessionOperationId()
      operationIds.current.set(key, clientOperationId)
      const sequence = ++nextMutationSequence.current
      const targetScope = requestScope
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
        const message = error instanceof Error ? error.message : 'Request was not sent'
        if (
          enabledRef.current &&
          requestScopeRef.current === targetScope &&
          stateRef.current.fence === targetFence &&
          sequence >= latestSettledSequence.current
        ) {
          latestSettledSequence.current = sequence
          writeErrorOwner.current = { operationId: clientOperationId, sequence }
          setWriteError(message)
        }
        return { status: 'unresolved', message }
      }
      if (!result.ok) {
        const operationState = agentSessionRefusalOperationState(
          fingerprintMethod,
          result.refusal.code
        )
        if (operationState === 'settled-rejected') {
          operationIds.current.delete(key)
        }
        if (
          enabledRef.current &&
          requestScopeRef.current === targetScope &&
          stateRef.current.fence === targetFence &&
          sequence >= latestSettledSequence.current
        ) {
          latestSettledSequence.current = sequence
          writeErrorOwner.current = { operationId: clientOperationId, sequence }
          setWriteError(result.refusal.message)
        }
        return operationState === 'unknown'
          ? { status: 'unresolved', message: result.refusal.message }
          : { status: 'refused', message: result.refusal.message }
      }
      if (
        !enabledRef.current ||
        requestScopeRef.current !== targetScope ||
        stateRef.current.fence !== targetFence
      ) {
        return { status: 'refused', message: null }
      }
      if (!isUnconfirmedConversationCommand(fingerprintMethod, result.value)) {
        operationIds.current.delete(key)
      }
      if (sequence >= latestSettledSequence.current) {
        latestSettledSequence.current = sequence
        writeErrorOwner.current = null
        setWriteError(null)
      }
      return { status: 'completed', value: result.value }
    },
    [enabled, requestScope, sessionId, stateRef, target]
  )

  const mutate = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      options?: StructuredAgentSessionMutateOptions
    ): Promise<T | null> => {
      const result = await mutateWithDisposition<T>(method, fingerprintMethod, fields, options)
      return result.status === 'completed' ? result.value : null
    },
    [mutateWithDisposition]
  )

  const clearWriteError = useCallback((operationId: string) => {
    if (writeErrorOwner.current?.operationId !== operationId) {
      return
    }
    writeErrorOwner.current = null
    setWriteError(null)
  }, [])
  return { mutate, mutateWithDisposition, writeError, clearWriteError }
}
