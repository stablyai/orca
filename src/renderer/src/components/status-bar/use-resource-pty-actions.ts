import { useCallback, useRef, useState } from 'react'
import type { PtyFencedTerminationRequest } from '../../../../shared/pty-fenced-termination'
import type { ResourcePtyRow } from './resource-pty-view-model'
import type { useResourceSessionInventory } from './use-resource-session-inventory'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

export function ptyTerminationReason(reason: string): string {
  switch (reason) {
    case 'claimed':
      return translate(
        'resourceManager.pty.claimed',
        'An agent now owns this terminal. Refresh before trying again.'
      )
    case 'attached':
      return translate(
        'resourceManager.pty.attached',
        'A client is now attached to this terminal. Refresh before trying again.'
      )
    case 'unsupported':
      return translate(
        'resourceManager.pty.endUnsupported',
        'End is unavailable for this terminal. Its host does not support the required safety checks. Close it from its tab or on its host.'
      )
    default:
      return translate(
        'resourceManager.pty.unverifiableEnd',
        'Unverifiable: the host could not confirm the result. The terminal may still be running.'
      )
  }
}

export function useResourcePtyActions(inventory: ReturnType<typeof useResourceSessionInventory>) {
  const [confirmation, setConfirmation] = useState<{
    request: PtyFencedTerminationRequest
    identity: string
    label: string
    location: string | null
    foregroundProcess: string | null
  } | null>(null)
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set())
  const endingRef = useRef(new Set<string>())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const mounted = useMountedRef()
  const { removeSession, invalidate } = inventory
  const confirm = useCallback((row: ResourcePtyRow): void => {
    if (
      !row.session.incarnationId ||
      !row.session.fencedTermination ||
      row.session.exiting ||
      endingRef.current.has(row.identity)
    ) {
      return
    }
    setConfirmation({
      identity: row.identity,
      label: row.label,
      location: [row.project, row.workspace].filter(Boolean).join(' / ') || row.session.cwd || null,
      foregroundProcess: row.session.foregroundProcess ?? null,
      request: {
        id: row.session.id,
        expectedIncarnationId: row.session.incarnationId,
        requireNoAgentOwner: row.session.agentOwnership === 'absent',
        requireUnattached: row.binding === 'unbound'
      }
    })
  }, [])
  const endConfirmed = useCallback(async (): Promise<void> => {
    if (!confirmation || endingRef.current.has(confirmation.identity)) {
      return
    }
    const target = confirmation
    endingRef.current.add(target.identity)
    setEnding(new Set(endingRef.current))
    setErrors((previous) => {
      const next = new Map(previous)
      next.delete(target.identity)
      return next
    })
    try {
      const result = await window.api.pty.killFenced(target.request)
      if (
        result.outcome === 'ended' ||
        result.outcome === 'already_exited' ||
        (result.outcome === 'refused' && result.reason === 'replaced')
      ) {
        removeSession(target.request.id, target.request.expectedIncarnationId)
      } else if (mounted.current && result.outcome === 'refused') {
        setErrors((previous) =>
          new Map(previous).set(target.identity, ptyTerminationReason(result.reason))
        )
      }
    } catch {
      if (mounted.current) {
        setErrors((previous) =>
          new Map(previous).set(target.identity, ptyTerminationReason('unverifiable'))
        )
      }
    } finally {
      endingRef.current.delete(target.identity)
      if (mounted.current) {
        setEnding(new Set(endingRef.current))
        setConfirmation(null)
      }
      invalidate()
    }
  }, [confirmation, invalidate, mounted, removeSession])
  return { confirmation, setConfirmation, ending, errors, confirm, endConfirmed }
}
