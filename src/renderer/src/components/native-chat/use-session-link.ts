import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import {
  SessionLink,
  SessionLinkParticipant,
  SessionLinkSnapshot,
  SESSION_LINK_POLICY_CAPABILITY,
  SESSION_LINK_CAPABILITY
} from '../../../../shared/session-link'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { translate as t } from '@/i18n/i18n'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  callStructuredAgentSession,
  structuredAgentSessionHostSupports
} from '@/runtime/structured-agent-session-client'

const Candidates = z.object({
  source: SessionLinkParticipant,
  candidates: z.array(SessionLinkParticipant),
  history: z.array(SessionLink)
})
type LinkMutation = { method: string; fields: Record<string, unknown>; operationId: string }

export function useSessionLink(sessionId: string, target: RuntimeClientTarget, open: boolean) {
  const [supported, setSupported] = useState(false)
  const [policySupported, setPolicySupported] = useState(false)
  const [snapshot, setSnapshot] = useState<SessionLinkSnapshot | null>(null)
  const [candidates, setCandidates] = useState<z.infer<typeof Candidates> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const selected = useRef<string | null>(null)
  const request = useRef<LinkMutation | null>(null)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const readSequence = useRef(0)
  const invalidate = useCallback(() => {
    generation.current++
    readSequence.current++
  }, [])
  const invalidateReads = useCallback(() => {
    readSequence.current++
  }, [])
  const targetKey = target.kind === 'local' ? null : target.environmentId
  const destination = useMemo<RuntimeClientTarget>(
    () =>
      targetKey === null ? { kind: 'local' } : { kind: 'environment', environmentId: targetKey },
    [targetKey]
  )

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      return
    }
    const issuedAt = generation.current
    const sequence = ++readSequence.current
    const id = open ? selected.current : null
    const result = await callStructuredAgentSession<unknown>(
      destination,
      id ? 'orchestration.linkShow' : 'orchestration.linkCurrent',
      id ? { id } : { sessionId }
    )
    if (issuedAt !== generation.current || sequence !== readSequence.current) {
      return
    }
    const value = result === null ? null : SessionLinkSnapshot.parse(result)
    const pending = request.current
    if (
      pending &&
      value &&
      (value.link.id === pending.operationId ||
        value.events.some((e) => e.requestId === pending.operationId))
    ) {
      request.current = null
      setUncertain(false)
      setError('')
    }
    setSnapshot(value)
  }, [open, sessionId, destination])

  useEffect(() => {
    let cancelled = false
    selected.current = null
    request.current = null
    inFlight.current = false
    setSnapshot(null)
    setBusy(false)
    setUncertain(false)
    setError('')
    setCandidates(null)
    setSupported(false)
    setPolicySupported(false)
    if (destination.kind === 'local') {
      void Promise.all([
        structuredAgentSessionHostSupports(destination, SESSION_LINK_CAPABILITY),
        structuredAgentSessionHostSupports(destination, SESSION_LINK_POLICY_CAPABILITY)
      ]).then(([ok, policyOk]) => {
        if (!cancelled) {
          setSupported(ok)
          setPolicySupported(policyOk)
        }
      })
    }
    return () => {
      cancelled = true
      invalidate()
    }
  }, [sessionId, destination, invalidate])

  useEffect(() => {
    if (!open) {
      selected.current = null
    }
    if (!supported) {
      return
    }
    let cancelled = false
    const read = async () => {
      try {
        if (!cancelled) {
          await refresh()
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), open ? 1500 : 5000)
    return () => {
      cancelled = true
      invalidateReads()
      window.clearInterval(timer)
    }
  }, [open, refresh, supported, invalidateReads])

  useEffect(() => {
    if (!open || !supported) {
      return
    }
    let cancelled = false
    void callStructuredAgentSession<unknown>(destination, 'orchestration.linkCandidates', {
      sessionId
    })
      .then((result) => {
        if (!cancelled) {
          setCandidates(Candidates.parse(result))
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, supported, destination])

  const execute = async (operation: LinkMutation) => {
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
  const mutate = (method: string, fields: Record<string, unknown>) => {
    if (request.current) {
      setError(
        t(
          'components.sessionLink.retryFirst',
          'The previous action is unconfirmed. Retry that action before starting another.'
        )
      )
      return Promise.resolve(false)
    }
    return execute({ method, fields, operationId: createBrowserUuid() })
  }
  const retry = () => (request.current ? execute(request.current) : Promise.resolve(false))
  const show = async (id: string) => {
    selected.current = id
    const issuedAt = generation.current
    try {
      await refresh()
    } catch (e) {
      if (issuedAt === generation.current && selected.current === id) {
        selected.current = null
        invalidateReads()
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }
  return {
    supported,
    policySupported,
    snapshot,
    candidates,
    error,
    busy,
    uncertain,
    mutate,
    retry,
    show
  }
}
