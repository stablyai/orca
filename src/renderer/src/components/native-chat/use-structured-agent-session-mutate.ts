// One structured-session mutation, fenced and idempotent.
//
// The client operation id is keyed on (session, method, payload) so a retry of
// the same request reuses it and the host upserts one row instead of two, and
// every result is discarded unless the runtime fence it was issued against is
// still the current one.

import { useCallback, useEffect, useRef, useState } from 'react'
import * as conversationCommands from './structured-conversation-command-send'
import type { AgentSessionMutationResult } from '../../../../shared/agent-session-wire'
import { agentSessionRefusalOperationState } from '../../../../shared/agent-session-refusal-retry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredSessionOperationId } from './use-structured-agent-session-outbox'

export type StructuredAgentSessionMutate = <T>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>,
  operationIdOverride?: string | null
) => Promise<T | null>

export function useStructuredAgentSessionMutate(args: {
  sessionId: string
  target: RuntimeClientTarget
  enabled?: boolean
  /** Read at settle time, not at call time: the fence can move while a request
   *  is in flight, and a result from the previous fence is not this session's. */
  stateRef: { current: { fence: number | null } }
}): {
  mutate: StructuredAgentSessionMutate
  writeError: string | null
  /** A write this hook did not send, refused all the same (a pick applied by the launch). */
  reportWriteError: (message: string) => void
} {
  const { enabled = true, sessionId, stateRef, target } = args
  const [writeError, setWriteError] = useState<string | null>(null)
  const operationIds = useRef(new Map<string, string>())
  const enabledRef = useRef(enabled)
  useEffect(() => {
    // Why: update the gate after commit so render stays free of ref mutations.
    enabledRef.current = enabled
  }, [enabled])

  const mutate = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      operationIdOverride?: string | null
    ): Promise<T | null> => {
      if (!enabled || !enabledRef.current || stateRef.current.fence === null) {
        return null
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
        if (enabledRef.current && stateRef.current.fence === targetFence) {
          setWriteError(error instanceof Error ? error.message : 'Request was not sent')
        }
        return null
      }
      if (!result.ok) {
        if (agentSessionRefusalOperationState(result.refusal.code) === 'settled-rejected') {
          operationIds.current.delete(key)
        }
        if (enabledRef.current && stateRef.current.fence === targetFence) {
          setWriteError(result.refusal.message)
        }
        return null
      }
      if (!enabledRef.current || stateRef.current.fence !== targetFence) {
        return null
      }
      if (!conversationCommands.isUnconfirmedConversationCommand(fingerprintMethod, result.value)) {
        operationIds.current.delete(key)
      }
      setWriteError(null)
      return result.value
    },
    [enabled, sessionId, stateRef, target]
  )

  return { mutate, writeError, reportWriteError: setWriteError }
}
