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
  source: 'lifecycle' | 'visible'
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

const FOLLOW_OUTPUT_FLUSH_CHARS = 256 * 1024

export function useTerminalScrollVisibilityMemory({
  managerRef,
  isVisibleRef,
  visibleResumeCompleteRef,
  paneCount
}: UseTerminalScrollVisibilityMemoryArgs): TerminalScrollVisibilityMemory {
  const visibleScrollSnapshotsRef = useRef<Map<number, VisibleScrollSnapshot>>(new Map())
  const scrollDisposablesRef = useRef<Map<number, IDisposable>>(new Map())
  const scrollContainerTargetsRef = useRef<Map<number, HTMLElement>>(new Map())
  const suppressScrollTrackingRef = useRef(false)
  const pendingFollowOutputPaneIdsRef = useRef<Set<number>>(new Set())
  const followOutputFrameIdsRef = useRef<number[]>([])

  const captureVisibleScrollSnapshot = useCallback(
    (terminal: Terminal, source: VisibleScrollSnapshot['source']): VisibleScrollSnapshot => ({
      scrollState: captureScrollState(terminal),
      outputEpoch: getTerminalOutputEpoch(terminal),
      source
    }),
    []
  )

  const rememberVisibleScrollSnapshot = useCallback(
    (paneId: number, terminal: Terminal): void => {
      visibleScrollSnapshotsRef.current.set(
        paneId,
        captureVisibleScrollSnapshot(terminal, 'visible')
      )
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
        manager.getPanes().flatMap((pane) => {
          const remembered = visibleScrollSnapshotsRef.current.get(pane.id)
          if (useRememberedSnapshots && remembered?.source === 'visible') {
            return [[pane.id, remembered.scrollState] as const]
          }
          if (useRememberedSnapshots) {
            return []
          }
          const state = captureScrollState(pane.terminal)
          visibleScrollSnapshotsRef.current.set(pane.id, {
            scrollState: state,
            outputEpoch: getTerminalOutputEpoch(pane.terminal),
            source: 'lifecycle'
          })
          return [[pane.id, state] as const]
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
      // Why: focus/follow can run immediately after a hidden pane becomes
      // visible. A bounded flush is enough to observe new output without
      // putting the whole hidden PTY backlog back on the interaction path.
      flushTerminalOutput(pane.terminal, { maxChars: FOLLOW_OUTPUT_FLUSH_CHARS })
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
    if (typeof window === 'undefined') {
      return
    }
    const rememberScrolledPane = (event: Event): void => {
      if (!isVisibleRef.current || suppressScrollTrackingRef.current) {
        return
      }
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getPanes().find((candidate) => candidate.container.contains(target))
      if (pane) {
        rememberVisibleScrollSnapshot(pane.id, pane.terminal)
      }
    }
    // Why: split layout can replace pane containers without changing pane ids.
    // Delegating catches xterm viewport scrolls even while pane bindings churn.
    window.addEventListener('scroll', rememberScrolledPane, true)
    return () => window.removeEventListener('scroll', rememberScrolledPane, true)
  }, [isVisibleRef, managerRef, rememberVisibleScrollSnapshot])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const disposables = scrollDisposablesRef.current
    const scrollContainerTargets = scrollContainerTargetsRef.current
    const panes = manager.getPanes()
    const paneById = new Map(panes.map((pane) => [pane.id, pane]))
    for (const [paneId, disposable] of disposables) {
      const pane = paneById.get(paneId)
      if (!pane || scrollContainerTargets.get(paneId) !== pane.container) {
        disposable.dispose()
        disposables.delete(paneId)
        scrollContainerTargets.delete(paneId)
        if (!pane) {
          visibleScrollSnapshotsRef.current.delete(paneId)
          pendingFollowOutputPaneIdsRef.current.delete(paneId)
        }
      }
    }
    for (const pane of panes) {
      if (disposables.has(pane.id)) {
        continue
      }
      const paneDisposables: IDisposable[] = []
      const rememberPaneScroll = (): void => {
        if (!isVisibleRef.current || suppressScrollTrackingRef.current) {
          return
        }
        rememberVisibleScrollSnapshot(pane.id, pane.terminal)
      }
      const onScroll = (
        pane.terminal as Terminal & {
          onScroll?: (listener: (position: number) => void) => IDisposable
        }
      ).onScroll
      if (typeof onScroll === 'function') {
        paneDisposables.push(onScroll.call(pane.terminal, rememberPaneScroll))
      }
      if (pane.container) {
        // Why: xterm's viewport element may be recreated after this effect.
        // Capture-phase listening on the pane catches descendant scrollbar moves.
        pane.container.addEventListener('scroll', rememberPaneScroll, true)
        paneDisposables.push({
          dispose: () => pane.container.removeEventListener('scroll', rememberPaneScroll, true)
        })
      }
      if (paneDisposables.length === 0) {
        continue
      }
      disposables.set(pane.id, {
        dispose: () => {
          for (const disposable of paneDisposables) {
            disposable.dispose()
          }
        }
      })
      scrollContainerTargets.set(pane.id, pane.container)
    }
    return () => {
      for (const disposable of disposables.values()) {
        disposable.dispose()
      }
      disposables.clear()
      scrollContainerTargets.clear()
    }
  }, [isVisibleRef, managerRef, paneCount, rememberVisibleScrollSnapshot])

  return {
    captureViewportPositions,
    withSuppressedScrollTracking,
    applyPendingFollowOutputRequests,
    scheduleFollowOutputIfNeeded
  }
}
