import { useCallback, useEffect, useRef } from 'react'
import type { IDisposable, Terminal } from '@xterm/xterm'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  cancelDeferredScrollRestore,
  captureScrollState,
  getTerminalOutputEpoch
} from '@/lib/pane-manager/pane-scroll'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'

type VisibleScrollSnapshot = {
  scrollState: ScrollState
  outputEpoch: number
}

type UseTerminalScrollVisibilityMemoryArgs = {
  managerRef: React.RefObject<PaneManager | null>
  isVisibleRef: React.RefObject<boolean>
  visibleResumeCompleteRef: React.RefObject<boolean>
  paneCount: number
}

type TerminalScrollVisibilityMemory = {
  captureViewportPositions: (useRememberedSnapshots: boolean) => Map<number, ScrollState>
  withSuppressedScrollTracking: (callback: () => void) => void
  applyPendingFollowOutputRequests: () => boolean
  scheduleFollowOutputIfNeeded: (paneId: number) => void
}

export function useTerminalScrollVisibilityMemory({
  managerRef,
  isVisibleRef,
  visibleResumeCompleteRef,
  paneCount
}: UseTerminalScrollVisibilityMemoryArgs): TerminalScrollVisibilityMemory {
  const visibleScrollSnapshotsRef = useRef<Map<number, VisibleScrollSnapshot>>(new Map())
  const scrollDisposablesRef = useRef<Map<number, IDisposable>>(new Map())
  const suppressScrollTrackingRef = useRef(false)
  const pendingFollowOutputPaneIdsRef = useRef<Set<number>>(new Set())

  const captureVisibleScrollSnapshot = useCallback(
    (terminal: Terminal): VisibleScrollSnapshot => ({
      scrollState: captureScrollState(terminal),
      outputEpoch: getTerminalOutputEpoch(terminal)
    }),
    []
  )

  const rememberVisibleScrollSnapshot = useCallback(
    (paneId: number, terminal: Terminal): void => {
      visibleScrollSnapshotsRef.current.set(paneId, captureVisibleScrollSnapshot(terminal))
    },
    [captureVisibleScrollSnapshot]
  )

  const captureViewportPositions = useCallback(
    (useRememberedSnapshots: boolean): Map<number, ScrollState> => {
      const manager = managerRef.current
      if (!manager) {
        return new Map()
      }
      return new Map(
        manager.getPanes().map((pane) => {
          const remembered = visibleScrollSnapshotsRef.current.get(pane.id)
          if (useRememberedSnapshots && remembered) {
            return [pane.id, remembered.scrollState] as const
          }
          const state = captureScrollState(pane.terminal)
          if (!useRememberedSnapshots || !remembered) {
            visibleScrollSnapshotsRef.current.set(pane.id, {
              scrollState: state,
              outputEpoch: getTerminalOutputEpoch(pane.terminal)
            })
          }
          return [pane.id, state] as const
        })
      )
    },
    [managerRef]
  )

  const withSuppressedScrollTracking = useCallback((callback: () => void): void => {
    suppressScrollTrackingRef.current = true
    try {
      callback()
    } finally {
      suppressScrollTrackingRef.current = false
    }
  }, [])

  const applyPendingFollowOutputRequests = useCallback((): boolean => {
    const pending = pendingFollowOutputPaneIdsRef.current
    if (pending.size === 0) {
      return false
    }
    if (!isVisibleRef.current || !visibleResumeCompleteRef.current) {
      return false
    }
    const manager = managerRef.current
    if (!manager) {
      return false
    }
    let didScroll = false
    for (const pane of manager.getPanes()) {
      if (!pending.has(pane.id)) {
        continue
      }
      const previous = visibleScrollSnapshotsRef.current.get(pane.id)
      flushTerminalOutput(pane.terminal)
      const currentEpoch = getTerminalOutputEpoch(pane.terminal)
      const hasNewOutput = previous ? currentEpoch > previous.outputEpoch : currentEpoch > 0
      if (hasNewOutput) {
        cancelDeferredScrollRestore(pane.terminal)
        pane.terminal.scrollToBottom()
        rememberVisibleScrollSnapshot(pane.id, pane.terminal)
        didScroll = true
      }
      pending.delete(pane.id)
    }
    return didScroll
  }, [isVisibleRef, managerRef, rememberVisibleScrollSnapshot, visibleResumeCompleteRef])

  const scheduleFollowOutputIfNeeded = useCallback(
    (paneId: number): void => {
      pendingFollowOutputPaneIdsRef.current.add(paneId)
      requestAnimationFrame(() => {
        requestAnimationFrame(applyPendingFollowOutputRequests)
      })
    },
    [applyPendingFollowOutputRequests]
  )

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const disposables = scrollDisposablesRef.current
    const panes = manager.getPanes()
    const livePaneIds = new Set(panes.map((pane) => pane.id))
    for (const [paneId, disposable] of disposables) {
      if (!livePaneIds.has(paneId)) {
        disposable.dispose()
        disposables.delete(paneId)
        visibleScrollSnapshotsRef.current.delete(paneId)
        pendingFollowOutputPaneIdsRef.current.delete(paneId)
      }
    }
    for (const pane of panes) {
      if (disposables.has(pane.id)) {
        continue
      }
      const onScroll = (
        pane.terminal as Terminal & {
          onScroll?: (listener: (position: number) => void) => IDisposable
        }
      ).onScroll
      if (typeof onScroll !== 'function') {
        continue
      }
      disposables.set(
        pane.id,
        onScroll.call(pane.terminal, () => {
          if (!isVisibleRef.current || suppressScrollTrackingRef.current) {
            return
          }
          rememberVisibleScrollSnapshot(pane.id, pane.terminal)
        })
      )
    }
    return () => {
      for (const disposable of disposables.values()) {
        disposable.dispose()
      }
      disposables.clear()
    }
  }, [isVisibleRef, managerRef, paneCount, rememberVisibleScrollSnapshot])

  return {
    captureViewportPositions,
    withSuppressedScrollTracking,
    applyPendingFollowOutputRequests,
    scheduleFollowOutputIfNeeded
  }
}
