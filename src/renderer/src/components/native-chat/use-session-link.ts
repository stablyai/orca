import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { executeSessionLinkMutation, type LinkMutation } from './session-link-mutation'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import {
  SessionLink,
  SessionLinkParticipant,
  SessionLinkSnapshot,
  SESSION_LINK_POLICY_CAPABILITY,
  SESSION_LINK_CAPABILITY,
  SESSION_LINK_PAIRED_DESKTOP_CAPABILITY,
  SESSION_LINK_GROUP_CAPABILITY
} from '../../../../shared/session-link'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useTranslate } from '@/i18n/use-translate'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { structuredAgentSessionHostSupports } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'

const Candidates = z.object({
  source: SessionLinkParticipant,
  candidates: z.array(SessionLinkParticipant),
  history: z.array(SessionLink)
})

export function useSessionLink(sessionId: string, target: RuntimeClientTarget, open: boolean) {
  const t = useTranslate()

  const [supported, setSupported] = useState(false)
  const [policySupported, setPolicySupported] = useState(false)
  const [groupSupported, setGroupSupported] = useState(false)
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
      { ...(id ? { id } : { sessionId }), ...(groupSupported ? { groupSupport: true } : {}) }
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
  }, [open, sessionId, destination, groupSupported])

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
    setGroupSupported(false)
    const probe = () =>
      void Promise.all([
        structuredAgentSessionHostSupports(
          destination,
          destination.kind === 'local'
            ? SESSION_LINK_CAPABILITY
            : SESSION_LINK_PAIRED_DESKTOP_CAPABILITY
        ),
        structuredAgentSessionHostSupports(destination, SESSION_LINK_POLICY_CAPABILITY),
        structuredAgentSessionHostSupports(destination, SESSION_LINK_GROUP_CAPABILITY)
      ]).then(([ok, policyOk, groupOk]) => {
        if (!cancelled) {
          setSupported(ok)
          setPolicySupported(policyOk)
          setGroupSupported(groupOk)
        }
      })
    probe()
    const unsubscribe =
      destination.kind === 'environment'
        ? subscribeRuntimeHostContactRegained(destination.environmentId, probe)
        : undefined
    return () => {
      unsubscribe?.()
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
    const stopPolling = installWindowVisibilityInterval({
      run: () => void read(),
      intervalMs: open ? 1500 : 5000
    })
    return () => {
      cancelled = true
      invalidateReads()
      stopPolling()
    }
  }, [open, refresh, supported, invalidateReads])

  useEffect(() => {
    if (!open || !supported) {
      return
    }
    let cancelled = false
    void callStructuredAgentSession<unknown>(destination, 'orchestration.linkCandidates', {
      sessionId,
      ...(groupSupported ? { groupSupport: true } : {})
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
  }, [open, sessionId, supported, destination, groupSupported, snapshot?.link.version])

  const execute = (operation: LinkMutation) =>
    executeSessionLinkMutation(operation, destination, {
      selected,
      request,
      inFlight,
      generation,
      readSequence,
      setBusy,
      setError,
      setSnapshot,
      setUncertain
    })

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
    return execute({
      method,
      fields: { ...fields, ...(groupSupported ? { groupSupport: true } : {}) },
      operationId: createBrowserUuid()
    })
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
    groupSupported,
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
