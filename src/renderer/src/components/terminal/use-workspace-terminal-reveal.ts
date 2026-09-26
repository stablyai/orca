import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { forEachLivePane } from '@/lib/pane-manager/pane-manager-registry'
import {
  getTerminalBacklogRecoveryCompletion,
  prepareTerminalBacklogRecovery,
  type TerminalBacklogRecoveryTarget
} from '@/lib/pane-manager/pane-terminal-output-queue-registry'

export const WORKSPACE_TERMINAL_REVEAL_BUDGET_MS = 300

function isBacklogRecoveryTarget(terminal: unknown): terminal is TerminalBacklogRecoveryTarget {
  return (
    typeof terminal === 'object' &&
    terminal !== null &&
    'element' in terminal &&
    terminal.element instanceof HTMLElement
  )
}

function pendingRestores(surface: HTMLElement, start = false): Promise<void>[] {
  const pending: Promise<void>[] = []
  forEachLivePane((_key, { terminal }) => {
    if (
      !isBacklogRecoveryTarget(terminal) ||
      !surface.contains(terminal.element) ||
      terminal.element.getClientRects().length === 0
    ) {
      return
    }
    const completion = start
      ? prepareTerminalBacklogRecovery(terminal)
      : getTerminalBacklogRecoveryCompletion(terminal)
    if (completion) {
      pending.push(completion)
    }
  })
  return pending
}

export function useWorkspaceTerminalReveal(
  containerRef: RefObject<HTMLDivElement | null>,
  selectedWorktreeId: string | null,
  visible: boolean
): { presentedWorktreeId: string | null; finishReveal: () => void } {
  const [presentedWorktreeId, setPresentedWorktreeId] = useState(selectedWorktreeId)
  const presentedRef = useRef(selectedWorktreeId)
  const releaseRef = useRef<(() => void) | null>(null)
  const finishReveal = useCallback(() => releaseRef.current?.(), [])

  useLayoutEffect(() => {
    const container = containerRef.current
    const surfaces = container ? Array.from(container.children) : []
    const findSurface = (id: string | null): HTMLElement | undefined =>
      surfaces.find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.dataset.worktreeRevealId === id
      )
    const destination = findSurface(selectedWorktreeId)
    const previous = findSurface(presentedRef.current)
    let cancelled = false
    let cancelWait = (): void => {}
    const cancellation = new Promise<void>((resolve) => {
      cancelWait = resolve
    })
    let timer: ReturnType<typeof setTimeout> | null = null
    let frame: number | null = null
    const release = (): void => {
      if (cancelled) {
        return
      }
      cancelled = true
      cancelWait()
      if (timer !== null) {
        clearTimeout(timer)
      }
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      releaseRef.current = null
      presentedRef.current = selectedWorktreeId
      setPresentedWorktreeId(selectedWorktreeId)
    }
    releaseRef.current = release
    const waits =
      visible && destination && previous && selectedWorktreeId !== presentedRef.current
        ? pendingRestores(destination, true)
        : []
    if (waits.length === 0) {
      release()
      return
    }
    // A slow/disconnected host must not hold navigation or input indefinitely.
    timer = setTimeout(release, WORKSPACE_TERMINAL_REVEAL_BUDGET_MS)
    const settle = async (pending: Promise<void>[]): Promise<void> => {
      await Promise.race([Promise.allSettled(pending), cancellation])
      if (cancelled) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = null
        if (cancelled || !destination) {
          return
        }
        // A restore may have scheduled another round or an inactive split pane.
        const remaining = pendingRestores(destination)
        if (remaining.length > 0) {
          void settle(remaining)
        } else {
          release()
        }
      })
    }
    void settle(waits)
    return () => {
      cancelled = true
      cancelWait()
      if (timer !== null) {
        clearTimeout(timer)
      }
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      releaseRef.current = null
    }
  }, [containerRef, selectedWorktreeId, visible])

  return { presentedWorktreeId, finishReveal }
}
