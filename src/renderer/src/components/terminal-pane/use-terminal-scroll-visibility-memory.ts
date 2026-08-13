import { useCallback, useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  cancelDeferredScrollRestore,
  captureScrollState,
  getTerminalOutputEpoch,
  releaseScrollStateMarker,
  restoreScrollState
} from '@/lib/pane-manager/pane-scroll'
import {
  getTerminalScrollIntentKind,
  markTerminalFollowOutput,
  markTerminalPinnedViewport
} from '@/lib/pane-manager/terminal-scroll-intent'
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
  restoreRememberedPinnedViewports: () => Set<number>
  withSuppressedScrollTracking: (callback: () => void) => void
  applyPendingFollowOutputRequests: () => boolean
  scheduleFollowOutputIfNeeded: (paneId: number) => void
}

const FOLLOW_OUTPUT_FLUSH_CHARS = 256 * 1024

export function useTerminalScrollVisibilityMemory({
  managerRef,
  isVisibleRef,
  visibleResumeCompleteRef,
  paneCount
}: UseTerminalScrollVisibilityMemoryArgs): TerminalScrollVisibilityMemory {
  const visibleScrollSnapshotsRef = useRef<Map<number, VisibleScrollSnapshot>>(new Map())
  const suppressScrollTrackingRef = useRef(false)
  const pendingFollowOutputPaneIdsRef = useRef<Set<number>>(new Set())
  const followOutputFrameIdsRef = useRef<number[]>([])

  const captureVisibleScrollSnapshot = useCallback(
    (terminal: Terminal): VisibleScrollSnapshot => ({
      scrollState: captureScrollState(terminal),
      outputEpoch: getTerminalOutputEpoch(terminal)
    }),
    []
  )

  // Why: captureScrollState registers xterm markers; dropping an entry without
  // disposing them leaks a marker per pane per visibility flip.
  const storeVisibleScrollSnapshot = useCallback(
    (paneId: number, snapshot: VisibleScrollSnapshot): void => {
      const previous = visibleScrollSnapshotsRef.current.get(paneId)
      if (previous && previous !== snapshot) {
        releaseScrollStateMarker(previous.scrollState)
      }
      visibleScrollSnapshotsRef.current.set(paneId, snapshot)
    },
    []
  )

  const rememberVisibleScrollSnapshot = useCallback(
    (paneId: number, terminal: Terminal): void => {
      storeVisibleScrollSnapshot(paneId, captureVisibleScrollSnapshot(terminal))
    },
    [captureVisibleScrollSnapshot, storeVisibleScrollSnapshot]
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
            storeVisibleScrollSnapshot(pane.id, {
              scrollState: state,
              outputEpoch: getTerminalOutputEpoch(pane.terminal)
            })
          }
          return [pane.id, state] as const
        })
      )
    },
    [managerRef, storeVisibleScrollSnapshot]
  )

  const restoreRememberedPinnedViewports = useCallback((): Set<number> => {
    const restoredPaneIds = new Set<number>()
    const manager = managerRef.current
    if (!manager) {
      return restoredPaneIds
    }
    for (const pane of manager.getPanes()) {
      const remembered = visibleScrollSnapshotsRef.current.get(pane.id)
      if (!remembered) {
        continue
      }
      const { scrollState } = remembered
      // Why: a pane that was following output must keep snapping to the bottom,
      // and restoring into an alternate buffer knocks a live TUI's cursor (#1298).
      if (scrollState.wasAtBottom || scrollState.bufferType !== 'normal') {
        continue
      }
      // Why: the hide-time markers survive scrollback trim and the viewport
      // collapse that display:none can inflict; the stored line number does not.
      if (restoreScrollState(pane.terminal, scrollState)) {
        markTerminalPinnedViewport(pane.terminal)
        // restoreScrollState disposes the markers, so re-anchor for the next hide.
        storeVisibleScrollSnapshot(pane.id, captureVisibleScrollSnapshot(pane.terminal))
      }
      restoredPaneIds.add(pane.id)
    }
    return restoredPaneIds
  }, [captureVisibleScrollSnapshot, managerRef, storeVisibleScrollSnapshot])

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
      // Why: focus/follow can run immediately after a hidden pane becomes
      // visible. A bounded flush is enough to observe new output without
      // putting the whole hidden PTY backlog back on the interaction path.
      flushTerminalOutput(pane.terminal, { maxChars: FOLLOW_OUTPUT_FLUSH_CHARS })
      const currentEpoch = getTerminalOutputEpoch(pane.terminal)
      const hasNewOutput = previous ? currentEpoch > previous.outputEpoch : currentEpoch > 0
      if (hasNewOutput) {
        if (getTerminalScrollIntentKind(pane.terminal) === 'followOutput') {
          cancelDeferredScrollRestore(pane.terminal)
          markTerminalFollowOutput(pane.terminal)
          pane.terminal.scrollToBottom()
          didScroll = true
        }
        rememberVisibleScrollSnapshot(pane.id, pane.terminal)
      }
      pending.delete(pane.id)
    }
    return didScroll
  }, [isVisibleRef, managerRef, rememberVisibleScrollSnapshot, visibleResumeCompleteRef])

  const cancelPendingFollowOutputFrames = useCallback((): void => {
    for (const frameId of followOutputFrameIdsRef.current) {
      cancelAnimationFrame(frameId)
    }
    followOutputFrameIdsRef.current = []
  }, [])

  const scheduleFollowOutputIfNeeded = useCallback(
    (paneId: number): void => {
      pendingFollowOutputPaneIdsRef.current.add(paneId)
      if (followOutputFrameIdsRef.current.length > 0) {
        return
      }
      const firstFrameId = requestAnimationFrame(() => {
        followOutputFrameIdsRef.current = followOutputFrameIdsRef.current.filter(
          (frameId) => frameId !== firstFrameId
        )
        const secondFrameId = requestAnimationFrame(() => {
          followOutputFrameIdsRef.current = followOutputFrameIdsRef.current.filter(
            (frameId) => frameId !== secondFrameId
          )
          applyPendingFollowOutputRequests()
        })
        followOutputFrameIdsRef.current.push(secondFrameId)
      })
      followOutputFrameIdsRef.current.push(firstFrameId)
    },
    [applyPendingFollowOutputRequests]
  )

  useEffect(() => cancelPendingFollowOutputFrames, [cancelPendingFollowOutputFrames])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    const livePaneIds = new Set(panes.map((pane) => pane.id))
    for (const [paneId, snapshot] of visibleScrollSnapshotsRef.current) {
      if (!livePaneIds.has(paneId)) {
        releaseScrollStateMarker(snapshot.scrollState)
        visibleScrollSnapshotsRef.current.delete(paneId)
        pendingFollowOutputPaneIdsRef.current.delete(paneId)
      }
    }
  }, [managerRef, paneCount])

  return {
    captureViewportPositions,
    restoreRememberedPinnedViewports,
    withSuppressedScrollTracking,
    applyPendingFollowOutputRequests,
    scheduleFollowOutputIfNeeded
  }
}
