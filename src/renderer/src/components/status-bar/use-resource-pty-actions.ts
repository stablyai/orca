import { useCallback, useEffect, useRef, useState } from 'react'
import type { PtyFencedTerminationRequest } from '../../../../shared/pty-fenced-termination'
import type { ResourcePtyRow } from './resource-pty-view-model'
import type { useResourceSessionInventory } from './use-resource-session-inventory'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

const COMPLETION_FLUSH_MS = 50
const MAX_CONCURRENT_TERMINATIONS = 4

type TerminationTarget = { identity: string; request: PtyFencedTerminationRequest }
type TerminationBatch = { pending: number; unpublished: number; resolve: () => void }
type QueuedTermination = TerminationTarget & { batch: TerminationBatch }
type TerminationCompletion = QueuedTermination & { remove: boolean; error?: string }

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
  const errorsRef = useRef(new Map<string, string>())
  const completions = useRef<TerminationCompletion[]>([])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queue = useRef<{ items: QueuedTermination[]; head: number; active: number }>({
    items: [],
    head: 0,
    active: 0
  })
  const mounted = useMountedRef()
  const { removeSessions, invalidate, sessionsError } = inventory
  const flushCompletions = useCallback(() => {
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    const completed = completions.current
    if (completed.length === 0) {
      return
    }
    completions.current = []
    const removed: { id: string; incarnationId: string }[] = []
    let errorsChanged = false
    for (const completion of completed) {
      endingRef.current.delete(completion.identity)
      if (completion.remove) {
        removed.push({
          id: completion.request.id,
          incarnationId: completion.request.expectedIncarnationId
        })
      }
      if (completion.error) {
        errorsRef.current.set(completion.identity, completion.error)
        errorsChanged = true
      }
    }
    if (removed.length > 0) {
      removeSessions(removed)
    }
    if (mounted.current) {
      setEnding(new Set(endingRef.current))
      if (errorsChanged) {
        setErrors(new Map(errorsRef.current))
      }
    }
    for (const completion of completed) {
      completion.batch.unpublished -= 1
      if (completion.batch.unpublished === 0) {
        completion.batch.resolve()
      }
    }
  }, [mounted, removeSessions])
  useEffect(() => () => flushCompletions(), [flushCompletions])

  const terminate = useCallback(
    async (target: QueuedTermination): Promise<void> => {
      const completion: TerminationCompletion = { ...target, remove: false }
      try {
        const result = await window.api.pty.killFenced(target.request)
        if (
          result.outcome === 'ended' ||
          result.outcome === 'already_exited' ||
          (result.outcome === 'refused' && result.reason === 'replaced')
        ) {
          completion.remove = true
        } else if (result.outcome === 'refused') {
          completion.error = ptyTerminationReason(result.reason)
        }
      } catch {
        completion.error = ptyTerminationReason('unverifiable')
      }
      completions.current.push(completion)
      target.batch.pending -= 1
      if (mounted.current) {
        if (flushTimer.current === null) {
          flushTimer.current = setTimeout(flushCompletions, COMPLETION_FLUSH_MS)
        }
      } else if (target.batch.pending === 0) {
        flushCompletions()
      }
    },
    [flushCompletions, mounted]
  )

  const drain = useCallback(
    function drain(): void {
      const pending = queue.current
      while (pending.active < MAX_CONCURRENT_TERMINATIONS && pending.head < pending.items.length) {
        const target = pending.items[pending.head++]!
        pending.active += 1
        void terminate(target).finally(() => {
          pending.active -= 1
          drain()
        })
      }
      if (pending.head === pending.items.length) {
        pending.items = []
        pending.head = 0
      } else if (pending.head >= 1024 && pending.head * 2 >= pending.items.length) {
        pending.items = pending.items.slice(pending.head)
        pending.head = 0
      }
      if (pending.active === 0) {
        flushCompletions()
        invalidate()
      }
    },
    [flushCompletions, invalidate, terminate]
  )
  const endMany = useCallback(
    async (rows: readonly ResourcePtyRow[]): Promise<void> => {
      if (sessionsError || !mounted.current) {
        return
      }
      const targets: TerminationTarget[] = []
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
      let errorsChanged = false
      for (const target of targets) {
        errorsChanged = errorsRef.current.delete(target.identity) || errorsChanged
      }
      if (errorsChanged) {
        setErrors(new Map(errorsRef.current))
      }
      await new Promise<void>((resolve) => {
        const batch: TerminationBatch = {
          pending: targets.length,
          unpublished: targets.length,
          resolve
        }
        for (const target of targets) {
          queue.current.items.push({ ...target, batch })
        }
        drain()
      })
    },
    [drain, mounted, sessionsError]
  )
  const end = useCallback((row: ResourcePtyRow): void => void endMany([row]), [endMany])
  return { ending, errors, end, endMany }
}

export function canEndResourcePty(row: ResourcePtyRow): boolean {
  return !!row.session.incarnationId && !!row.session.fencedTermination && !row.session.exiting
}
