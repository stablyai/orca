import { useCallback, useEffect, useRef } from 'react'
import type { IDisposable, Terminal } from '@xterm/xterm'
import { flushTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  cancelDeferredScrollRestore,
  captureScrollState,
  getPendingScrollRestoreState,
  getTerminalOutputEpoch,
  isTerminalScrollRestoreInProgress,
  rememberTerminalContainerScrollState,
  rememberTerminalLeafScrollState,
  rememberTerminalScrollState
} from '@/lib/pane-manager/pane-scroll'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ManagedPane, ScrollState } from '@/lib/pane-manager/pane-manager-types'

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
  captureViewportPositions: (
    useRememberedSnapshots: boolean
  ) => Map<ManagedPane['leafId'], ScrollState>
  withSuppressedScrollTracking: (callback: () => void) => void
  applyPendingFollowOutputRequests: () => boolean
  scheduleFollowOutputIfNeeded: (leafId: ManagedPane['leafId']) => void
}

const FOLLOW_OUTPUT_FLUSH_CHARS = 256 * 1024

function isTransientTerminalEdgeSnap(current: ScrollState, previous: ScrollState): boolean {
  if (previous.wasAtBottom || current.bufferType !== previous.bufferType) {
    return false
  }
  if (current.viewportY === previous.viewportY) {
    return false
  }
  return (
    Math.abs(current.baseY - previous.baseY) <= 2 &&
    (current.viewportY === 0 || current.wasAtBottom)
  )
}

export function useTerminalScrollVisibilityMemory({
  managerRef,
  isVisibleRef,
  visibleResumeCompleteRef,
  paneCount
}: UseTerminalScrollVisibilityMemoryArgs): TerminalScrollVisibilityMemory {
  const visibleScrollSnapshotsRef = useRef<Map<ManagedPane['leafId'], VisibleScrollSnapshot>>(
    new Map()
  )
  const scrollDisposablesRef = useRef<Map<ManagedPane['leafId'], IDisposable>>(new Map())
  const suppressScrollTrackingRef = useRef(false)
  const pendingFollowOutputLeafIdsRef = useRef<Set<ManagedPane['leafId']>>(new Set())
  const followOutputFrameIdsRef = useRef<number[]>([])

  const captureVisibleScrollSnapshot = useCallback((terminal: Terminal): VisibleScrollSnapshot => {
    const scrollState = captureScrollState(terminal)
    rememberTerminalScrollState(terminal, scrollState)
    return {
      scrollState,
      outputEpoch: getTerminalOutputEpoch(terminal)
    }
  }, [])

  const rememberVisibleScrollSnapshot = useCallback(
    (leafId: ManagedPane['leafId'], terminal: Terminal): void => {
      const snapshot = captureVisibleScrollSnapshot(terminal)
      const previous = visibleScrollSnapshotsRef.current.get(leafId)
      const scrollState =
        previous && isTransientTerminalEdgeSnap(snapshot.scrollState, previous.scrollState)
          ? previous.scrollState
          : snapshot.scrollState
      const pane = managerRef.current?.getPanes().find((candidate) => candidate.leafId === leafId)
      if (pane) {
        rememberTerminalContainerScrollState(pane.container, scrollState)
      }
      rememberTerminalLeafScrollState(leafId, scrollState)
      visibleScrollSnapshotsRef.current.set(leafId, {
        outputEpoch: snapshot.outputEpoch,
        scrollState
      })
    },
    [captureVisibleScrollSnapshot, managerRef]
  )

  const captureViewportPositions = useCallback(
    (useRememberedSnapshots: boolean): Map<ManagedPane['leafId'], ScrollState> => {
      const manager = managerRef.current
      if (!manager) {
        return new Map()
      }
      return new Map(
        manager.getPanes().map((pane) => {
          const remembered = visibleScrollSnapshotsRef.current.get(pane.leafId)
          if (useRememberedSnapshots && remembered) {
            return [pane.leafId, remembered.scrollState] as const
          }
          const state =
            getPendingScrollRestoreState(pane.terminal) ?? captureScrollState(pane.terminal)
          const stableState =
            remembered && isTransientTerminalEdgeSnap(state, remembered.scrollState)
              ? remembered.scrollState
              : state
          if (!useRememberedSnapshots || !remembered) {
            rememberTerminalScrollState(pane.terminal, stableState)
            rememberTerminalContainerScrollState(pane.container, stableState)
            rememberTerminalLeafScrollState(pane.leafId, stableState)
            visibleScrollSnapshotsRef.current.set(pane.leafId, {
              scrollState: stableState,
              outputEpoch: getTerminalOutputEpoch(pane.terminal)
            })
          }
          return [pane.leafId, stableState] as const
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
    const pending = pendingFollowOutputLeafIdsRef.current
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
      if (!pending.has(pane.leafId)) {
        continue
      }
      const previous = visibleScrollSnapshotsRef.current.get(pane.leafId)
      // Why: focus/follow can run immediately after a hidden pane becomes
      // visible. A bounded flush is enough to observe new output without
      // putting the whole hidden PTY backlog back on the interaction path.
      flushTerminalOutput(pane.terminal, { maxChars: FOLLOW_OUTPUT_FLUSH_CHARS })
      const currentEpoch = getTerminalOutputEpoch(pane.terminal)
      const hasNewOutput = previous ? currentEpoch > previous.outputEpoch : currentEpoch > 0
      if (hasNewOutput && (previous?.scrollState.wasAtBottom ?? true)) {
        cancelDeferredScrollRestore(pane.terminal)
        pane.terminal.scrollToBottom()
        rememberVisibleScrollSnapshot(pane.leafId, pane.terminal)
        didScroll = true
      }
      pending.delete(pane.leafId)
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
    (leafId: ManagedPane['leafId']): void => {
      pendingFollowOutputLeafIdsRef.current.add(leafId)
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
    const disposables = scrollDisposablesRef.current
    const panes = manager.getPanes()
    const liveLeafIds = new Set(panes.map((pane) => pane.leafId))
    for (const [leafId, disposable] of disposables) {
      if (!liveLeafIds.has(leafId)) {
        disposable.dispose()
        disposables.delete(leafId)
        visibleScrollSnapshotsRef.current.delete(leafId)
      }
    }
    for (const pane of panes) {
      if (disposables.has(pane.leafId)) {
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
        pane.leafId,
        onScroll.call(pane.terminal, () => {
          if (
            !isVisibleRef.current ||
            suppressScrollTrackingRef.current ||
            isTerminalScrollRestoreInProgress(pane.terminal)
          ) {
            return
          }
          rememberVisibleScrollSnapshot(pane.leafId, pane.terminal)
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
