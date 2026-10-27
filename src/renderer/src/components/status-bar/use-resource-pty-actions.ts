import { useCallback, useRef, useState } from 'react'
import type { PtyFencedTerminationRequest } from '../../../../shared/pty-fenced-termination'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'
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
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set())
  const endingRef = useRef(new Set<string>())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const mounted = useMountedRef()
  const { removeSession, invalidate, sessionsError } = inventory
  const endMany = useCallback(
    async (rows: readonly ResourcePtyRow[]): Promise<void> => {
      if (sessionsError) {
        return
      }
      const targets: { identity: string; request: PtyFencedTerminationRequest }[] = []
      for (const row of rows) {
        if (
          !canEndResourcePty(row) ||
          !row.session.incarnationId ||
          endingRef.current.has(row.identity)
        ) {
          continue
        }
        endingRef.current.add(row.identity)
        targets.push({
          identity: row.identity,
          request: {
            id: row.session.id,
            expectedIncarnationId: row.session.incarnationId,
            requireNoAgentOwner: row.session.agentOwnership === 'absent',
            requireUnattached: row.binding === 'unbound'
          }
        })
      }
      if (targets.length === 0) {
        return
      }
      setEnding(new Set(endingRef.current))
      setErrors((previous) => {
        const next = new Map(previous)
        for (const target of targets) {
          next.delete(target.identity)
        }
        return next
      })
      await forEachWithConcurrency(targets, 4, async (target) => {
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
          }
          invalidate()
        }
      })
    },
    [invalidate, mounted, removeSession, sessionsError]
  )
  const end = useCallback((row: ResourcePtyRow): void => void endMany([row]), [endMany])
  return { ending, errors, end, endMany }
}

export function canEndResourcePty(row: ResourcePtyRow): boolean {
  return !!row.session.incarnationId && !!row.session.fencedTermination && !row.session.exiting
}
