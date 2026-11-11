import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentSessionHooks,
  AgentSessionHookTrust
} from '../../../../../shared/agent-session/agent-session-hooks'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { NativeChatHooksModalRequest } from './native-chat-hooks-modal'

export function useNativeChatHooks(request: NativeChatHooksModalRequest) {
  const [result, setResult] = useState<AgentSessionHooks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const operation = useRef({ generation: 0, pending: false })
  const load = useCallback(
    async (trust?: AgentSessionHookTrust) => {
      if (operation.current.pending) {
        return
      }
      operation.current.pending = true
      const current = ++operation.current.generation
      setBusy(true)
      setError(null)
      try {
        const next = await callStructuredAgentSession<AgentSessionHooks>(
          request.target,
          'agentSession.hooks',
          {
            sessionId: request.sessionId,
            ...(trust ? { trust } : {})
          }
        )
        if (current === operation.current.generation) {
          setResult(next)
        }
      } catch (cause) {
        if (current === operation.current.generation) {
          setResult(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
      if (current === operation.current.generation) {
        operation.current.pending = false
        setBusy(false)
      }
    },
    [request]
  )
  const dispose = useCallback(() => {
    operation.current.generation++
    operation.current.pending = false
  }, [])
  useEffect(() => {
    void load()
    return dispose
  }, [load, dispose])
  return { result, error, busy, load }
}
