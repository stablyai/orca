import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useAppStore } from '@/store'
import type { PendingSidebarRowReveal, PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { completeMountedSidebarReveal } from './complete-mounted-reveal'
import type { PendingSidebarRevealArgs } from './pending-reveal-inputs'

type RevealRequest = PendingSidebarWorktreeReveal | PendingSidebarRowReveal
type MountedOwner = { request: RevealRequest; cancelled: boolean }

const consumedRenameRequests = new WeakSet<PendingSidebarWorktreeReveal>()

export function useMountedSidebarRevealOwner(argsRef: RefObject<PendingSidebarRevealArgs>) {
  const ownerRef = useRef<MountedOwner | null>(null)
  const cancel = useCallback(() => {
    if (ownerRef.current) {
      ownerRef.current.cancelled = true
    }
    ownerRef.current = null
  }, [])
  useLayoutEffect(() => cancel, [cancel])

  const isCurrent = useCallback((owner: MountedOwner): boolean => {
    const state = useAppStore.getState()
    const current =
      'worktreeId' in owner.request ? state.pendingRevealWorktree : state.pendingRevealSidebarRow
    if (owner.cancelled || ownerRef.current !== owner || current !== owner.request) {
      owner.cancelled = true
      return false
    }
    return true
  }, [])
  const has = useCallback(
    (request: RevealRequest): boolean => {
      const owner = ownerRef.current
      return owner !== null && owner.request === request && isCurrent(owner)
    },
    [isCurrent]
  )
  const start = useCallback(
    (
      request: RevealRequest,
      container: HTMLElement,
      reveal: () => HTMLElement | null,
      fallbackRowKey: string | null,
      resetRetries: () => void
    ): boolean => {
      cancel()
      const owner: MountedOwner = { request, cancelled: false }
      ownerRef.current = owner
      if (!isCurrent(owner)) {
        return false
      }
      const element = reveal()
      if (!element) {
        if (ownerRef.current === owner) {
          cancel()
        }
        return false
      }
      completeMountedSidebarReveal({
        container,
        element,
        behavior: request.behavior,
        cancelled: () => !isCurrent(owner),
        isScrollSettling: () => argsRef.current.isRevealScrollSettling(),
        wasScrollInterrupted: () => argsRef.current.wasRevealScrollInterrupted(),
        markRevealScroll: (top) => argsRef.current.markRevealScroll(top),
        scheduleFrame: (frame) => argsRef.current.schedulePendingRevealFrame(frame),
        beginRename:
          'worktreeId' in request && request.beginRename
            ? () => {
                if (isCurrent(owner) && !consumedRenameRequests.has(request)) {
                  // Owner remounts resume motion without reopening a consumed edit.
                  consumedRenameRequests.add(request)
                  useAppStore.getState().setRenamingWorktreeId({
                    worktreeId: request.worktreeId,
                    rowKey: element.dataset.worktreeRowKey
                  })
                }
              }
            : undefined,
        complete: (landed) => {
          if (!isCurrent(owner)) {
            return
          }
          const rowKey =
            'rowKey' in request
              ? request.rowKey
              : (element.dataset.worktreeRowKey ?? fallbackRowKey)
          if (landed && request.highlight && rowKey) {
            argsRef.current.flashRevealedRow(rowKey)
          }
          // Highlight and rename can synchronously enqueue a replacement request.
          if (!isCurrent(owner)) {
            return
          }
          resetRetries()
          if ('worktreeId' in request) {
            argsRef.current.clearPendingRevealWorktreeId()
          } else {
            argsRef.current.clearPendingRevealSidebarRow()
          }
          if (ownerRef.current === owner) {
            cancel()
          }
        }
      })
      return true
    },
    [argsRef, cancel, isCurrent]
  )
  return useMemo(() => ({ has, start, cancel }), [has, start, cancel])
}
