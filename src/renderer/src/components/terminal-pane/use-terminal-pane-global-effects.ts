import { useEffect, useRef } from 'react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { shellEscapePath } from './pane-helpers'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import type { PtyTransport } from './pty-transport'

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  isActive: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  pendingWritesRef: React.RefObject<Map<number, string>>
  isActiveRef: React.RefObject<boolean>
  toggleExpandPane: (paneId: number) => void
}

export function useTerminalPaneGlobalEffects({
  tabId,
  isActive,
  managerRef,
  containerRef,
  paneTransportsRef,
  pendingWritesRef,
  isActiveRef,
  toggleExpandPane
}: UseTerminalPaneGlobalEffectsArgs): void {
  const wasActiveRef = useRef(false)

  // Why: tracks any in-progress chunked pending-write flush so the cleanup
  // function can cancel it if the pane deactivates mid-flush.
  const pendingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    if (isActive) {
      manager.resumeRendering()

      // Why: while a worktree is in the background, PTY output accumulates
      // in pendingWritesRef with no size cap.  A Claude agent running for
      // minutes can produce hundreds of KB.  Writing it all in one
      // synchronous terminal.write() blocks the renderer for 2–5 s on
      // Windows, freezing the UI on every worktree switch.
      //
      // Fix: drain each pane's pending buffer in 32 KB chunks with a
      // setTimeout(0) yield between chunks.  This lets the browser paint
      // frames and process input events between chunks so the UI stays
      // responsive while the scrollback catches up.  The fit is deferred
      // until after the final chunk so xterm only reflows once.
      const CHUNK_SIZE = 32 * 1024
      const entries = Array.from(pendingWritesRef.current.entries()).filter(
        ([, buf]) => buf.length > 0
      )
      // Clear all pending buffers immediately so new PTY output arriving
      // during the flush goes into a fresh buffer instead of being lost.
      for (const [paneId] of entries) {
        pendingWritesRef.current.set(paneId, '')
      }

      if (entries.length === 0) {
        requestAnimationFrame(() => fitAndFocusPanes(manager))
      } else {
        let entryIdx = 0
        let offset = 0

        const drainNextChunk = (): void => {
          if (entryIdx >= entries.length) {
            pendingFlushRef.current = null
            requestAnimationFrame(() => fitAndFocusPanes(manager))
            return
          }

          const [paneId, buffer] = entries[entryIdx]
          const pane = manager.getPanes().find((p) => p.id === paneId)
          if (!pane) {
            entryIdx++
            offset = 0
            pendingFlushRef.current = setTimeout(drainNextChunk, 0)
            return
          }

          const chunk = buffer.slice(offset, offset + CHUNK_SIZE)
          pane.terminal.write(chunk)
          offset += CHUNK_SIZE

          if (offset >= buffer.length) {
            entryIdx++
            offset = 0
          }

          // Yield to the browser between chunks so the UI stays responsive.
          pendingFlushRef.current = setTimeout(drainNextChunk, 0)
        }

        drainNextChunk()
      }
    } else if (wasActiveRef.current) {
      // Cancel any in-progress chunked flush before suspending.
      if (pendingFlushRef.current !== null) {
        clearTimeout(pendingFlushRef.current)
        pendingFlushRef.current = null
      }
      manager.suspendRendering()
    }
    wasActiveRef.current = isActive
    isActiveRef.current = isActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  useEffect(() => {
    const onToggleExpand = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length < 2) {
        return
      }
      const pane = manager.getActivePane() ?? panes[0]
      if (!pane) {
        return
      }
      toggleExpandPane(pane.id)
    }
    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    return () => window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    // Why: ResizeObserver fires on every incremental size change during
    // continuous window resizes or layout animations.  Each fitPanes() call
    // triggers fitAddon.fit() → terminal.resize() which, when the column
    // count changes, reflows the entire scrollback buffer and recalculates
    // the viewport scroll position.  On Windows, a single reflow of 10 000
    // scrollback lines can block the renderer for 500 ms–2 s, freezing the
    // UI while a sidebar opens or a window resizes.
    //
    // A trailing-edge debounce (150 ms) coalesces bursts into one reflow
    // after the layout settles.  This is longer than the previous RAF-only
    // batch (≈16 ms) but still short enough that the user never notices the
    // terminal running at a stale column count.
    const RESIZE_DEBOUNCE_MS = 150
    let timerId: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (timerId !== null) {
        clearTimeout(timerId)
      }
      timerId = setTimeout(() => {
        timerId = null
        const manager = managerRef.current
        if (!manager) {
          return
        }
        fitPanes(manager)
      }, RESIZE_DEBOUNCE_MS)
    })
    resizeObserver.observe(container)
    return () => {
      resizeObserver.disconnect()
      if (timerId !== null) {
        clearTimeout(timerId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  useEffect(() => {
    return window.api.ui.onFileDrop((data) => {
      if (!isActiveRef.current || data.target !== 'terminal') {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      const transport = paneTransportsRef.current.get(pane.id)
      if (!transport) {
        return
      }
      // Why: preload consumes native OS drops before React sees them, so the
      // terminal cannot rely on DOM `drop` events for external files. Reusing
      // the active PTY transport preserves the existing CLI behavior for drag-
      // and-drop path insertion instead of opening those files in the editor.
      // Why: appending a trailing space keeps multiple paths separated in the
      // terminal input, matching standard drag-and-drop UX conventions.
      for (const path of data.paths) {
        transport.sendInput(`${shellEscapePath(path)} `)
      }
    })
  }, [isActiveRef, managerRef, paneTransportsRef])
}
