import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  CODEX_RESET_AUTHORITY_READING,
  useNativeChatUsageResetAuthority
} from './use-native-chat-usage-reset-authority'

/** The `/usage` modal's read of its chat's account; closing the modal retires every read. */
export function useNativeChatAccountUsage(sessionId: string, target: RuntimeClientTarget) {
  const [shown, setShown] = useState<{
    /** The newest read; late replies to older ones are dropped. */
    request: number
    result: AgentSessionAccountUsage | null
    /** A reset's outcome, kept across the refresh it triggers. */
    notice: string | null
  }>({ request: 0, result: null, notice: null })
  const nextRequest = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = useCallback(
    () =>
      callStructuredAgentSession<AgentSessionAccountUsage>(target, 'agentSession.accountUsage', {
        sessionId
      }),
    [sessionId, target]
  )
  const load = useCallback(
    async (request: number) => {
      const result = await read().catch(() => ({ status: 'failed' as const }))
      setShown((current) => (current.request === request ? { ...current, result } : current))
    },
    [read]
  )
  const refresh = useCallback(
    (notice: string | null = null) => {
      // A reset confirmed before the modal closed can finish after it; nothing is left to show.
      if (!mounted.current) {
        return
      }
      const request = ++nextRequest.current
      setShown({ request, result: null, notice })
      void load(request)
    },
    [load]
  )
  // The modal opens loading; its first read settles into that state.
  useEffect(() => {
    void load(nextRequest.current)
  }, [load])
  // The host builds the reset offer from its own Codex state, which can land after the modal
  // opened (its first read after launch, an account switch); re-read when it changes.
  // Watched from the opening, so a change during the first read is not mistaken for its baseline.
  const authority = useNativeChatUsageResetAuthority(target, true)
  const seenAuthority = useRef<string | null>(null)
  const resultShown = useRef(false)
  useEffect(() => {
    resultShown.current = shown.result !== null
  }, [shown])
  // One background read at a time; changes during it collapse into one follow-up.
  const reconciling = useRef<{ again: boolean } | null>(null)
  const reconcile = useCallback(() => {
    if (reconciling.current) {
      reconciling.current.again = true
      return
    }
    reconciling.current = { again: false }
    const request = ++nextRequest.current
    setShown((current) => ({ ...current, request }))
    void read()
      .catch(() => null)
      .then((result) => {
        // A failed background read keeps what the modal shows; one still loading shows it.
        setShown((current) =>
          current.request === request && (result?.status === 'ok' || current.result === null)
            ? { ...current, result: result ?? { status: 'failed' } }
            : current
        )
        const again = reconciling.current?.again === true
        reconciling.current = null
        if (again && mounted.current) {
          reconcile()
        }
      })
  }, [read])
  useEffect(() => {
    if (authority === null) {
      return
    }
    const previous = seenAuthority.current
    seenAuthority.current = authority
    // A host still reading has nothing new yet; its finished read is the change worth a re-read.
    if (authority === CODEX_RESET_AUTHORITY_READING || previous === authority) {
      return
    }
    // A first observation after the reply may postdate the state the host built the offer from.
    if (previous !== null || resultShown.current) {
      reconcile()
    }
  }, [authority, reconcile])
  return { result: shown.result, notice: shown.notice, refresh }
}
