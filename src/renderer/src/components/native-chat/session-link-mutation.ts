import type { RefObject } from 'react'
import { SessionLinkSnapshot } from '../../../../shared/session-link'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'

export type LinkMutation = { method: string; fields: Record<string, unknown>; operationId: string }

type SessionLinkMutationState = {
  selected: RefObject<string | null>
  request: RefObject<LinkMutation | null>
  inFlight: RefObject<boolean>
  generation: RefObject<number>
  readSequence: RefObject<number>
  setBusy: (busy: boolean) => void
  setError: (error: string) => void
  setSnapshot: (snapshot: SessionLinkSnapshot) => void
  setUncertain: (uncertain: boolean) => void
}

export async function executeSessionLinkMutation(
  operation: LinkMutation,
  destination: RuntimeClientTarget,
  state: SessionLinkMutationState
): Promise<boolean> {
  const {
    selected,
    request,
    inFlight,
    generation,
    readSequence,
    setBusy,
    setError,
    setSnapshot,
    setUncertain
  } = state
  if (inFlight.current) {
    return false
  }
  request.current = operation
  inFlight.current = true
  readSequence.current++
  const issuedAt = generation.current
  setBusy(true)
  setError('')
  try {
    const params =
      operation.method === 'orchestration.linkCreate'
        ? { ...operation.fields, id: operation.operationId }
        : { ...operation.fields, operationId: operation.operationId }
    const result = SessionLinkSnapshot.parse(
      await callStructuredAgentSession<unknown>(destination, operation.method, params)
    )
    if (issuedAt !== generation.current) {
      return false
    }
    selected.current = result.link.id
    setSnapshot(result)
    request.current = null
    setUncertain(false)
    return true
  } catch (e) {
    if (issuedAt !== generation.current) {
      return false
    }
    const data = e instanceof RuntimeRpcCallError ? e.response.error.data : undefined
    const refused =
      typeof data === 'object' &&
      data !== null &&
      'effectsApplied' in data &&
      data.effectsApplied === false
    if (refused || (e instanceof RuntimeRpcCallError && e.code === 'invalid_argument')) {
      request.current = null
    }
    setUncertain(request.current !== null)
    setError(e instanceof Error ? e.message : String(e))
    return false
  } finally {
    if (issuedAt === generation.current) {
      inFlight.current = false
      setBusy(false)
    }
  }
}
