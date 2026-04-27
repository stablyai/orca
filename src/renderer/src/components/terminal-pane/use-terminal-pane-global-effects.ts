import { useEffect, useRef } from 'react'
import {
  FOCUS_TERMINAL_PANE_EVENT,
  SYNC_FIT_PANES_EVENT,
  TOGGLE_TERMINAL_PANE_EXPAND_EVENT,
  type FocusTerminalPaneDetail
} from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { shellEscapePath } from './pane-helpers'
import { fitAndFocusPanes, fitPanes, hasDimensionsChanged } from './pane-helpers'
import type { PtyTransport } from './pty-transport'

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  isActive: boolean
  isVisible: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  pendingWritesRef: React.RefObject<Map<number, string>>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  toggleExpandPane: (paneId: number) => void
}

export function useTerminalPaneGlobalEffects({
  tabId,
  isActive,
  isVisible,
  managerRef,
  containerRef,
  paneTransportsRef,
  pendingWritesRef,
  isActiveRef,
  isVisibleRef,
  toggleExpandPane
}: UseTerminalPaneGlobalEffectsArgs): void {
  // Why: starts as `true` so the first render with isVisible=false triggers
  // suspendRendering(). Without this, background worktrees that mount hidden
  // (isVisible=false from the start) never suspend their WebGL contexts —
  // openTerminal() unconditionally creates a WebGL addon, but this effect
  // only suspends on true→false transitions. The leaked contexts exhaust
  // Chromium's ~8-context budget, causing "webglcontextlost" on visible
  // terminals and making them unresponsive.
  const wasVisibleRef = useRef(true)

  // Why: tracks any in-progress chunked pending-write flush so the cleanup
  // function can cancel it if the pane deactivates mid-flush.
  const pendingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Why: the deferred rAF (guardedFit) must be cancellable when the pane
  // deactivates before the rAF fires — otherwise it would call
  // fitAndFocusPanes() on a suspended manager.
  const pendingRafRef = useRef<number | null>(null)

  // Why: two independent code paths schedule fitPanes() after a worktree
  // switch — the isActive effect (after pending-write drain) and the
  // ResizeObserver (after its 150 ms debounce).  On Windows, each redundant
  // fit() call adds non-trivial overhead (clear + refresh of 10 000
  // scrollback lines).  An epoch counter lets whichever path fires first
  // serve the activation, while the second path skips.  The staleness
  // check also rejects callbacks from a prior activation during rapid
  // worktree switches (A→B→C).
  const fitEpochRef = useRef(0)
  const fitRanForEpochRef = useRef(-1)

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    if (isVisible) {
      // Why: resume WebGL immediately so the terminal shows its last-known
      // state on the first painted frame. Without this, the browser paints
      // 1+ frames of stale xterm DOM-fallback content at wrong dimensions
      // (the "stretched" flash). On macOS, WebGL context creation is ~5 ms
      // — fast enough to feel instant. On Windows (ANGLE → D3D11) it can
      // take 100–500 ms, but the alternative (deferring to a rAF) leaves
      // the terminal visibly distorted, which is a worse UX tradeoff.
      manager.resumeRendering()

      fitEpochRef.current++
      const epoch = fitEpochRef.current

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

      const guardedFit = (): void => {
        pendingRafRef.current = null
        const mgr = managerRef.current
        if (!mgr) {
          return
        }
        // Why: three-layer guard prevents redundant and stale fits.
        // 1. Staleness — reject callbacks from a superseded activation
        //    (e.g. rapid A→B→C worktree switch).
        if (epoch !== fitEpochRef.current) {
          return
        }
        // 2. Dimension check — if a window resize changed the container
        //    size, the fit must run even if one already ran for this epoch.
        const dimensionsChanged = hasDimensionsChanged(mgr)
        // 3. Dedup — if dims are the same and a fit already ran, skip.
        if (!dimensionsChanged && fitRanForEpochRef.current >= epoch) {
          return
        }
        fitRanForEpochRef.current = epoch
        if (isActive) {
          fitAndFocusPanes(mgr)
          return
        }
        fitPanes(mgr)
      }

      if (entries.length === 0) {
        pendingRafRef.current = requestAnimationFrame(guardedFit)
      } else {
        let entryIdx = 0
        let offset = 0

        const drainNextChunk = (): void => {
          if (entryIdx >= entries.length) {
            pendingFlushRef.current = null
            pendingRafRef.current = requestAnimationFrame(guardedFit)
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
    } else if (wasVisibleRef.current) {
      // Cancel any in-progress chunked flush before suspending.
      if (pendingFlushRef.current !== null) {
        clearTimeout(pendingFlushRef.current)
        pendingFlushRef.current = null
      }
      // Cancel any pending rAF so guardedFit doesn't run on a
      // suspended manager.
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current)
        pendingRafRef.current = null
      }
      manager.suspendRendering()
    }
    wasVisibleRef.current = isVisible
    isActiveRef.current = isActive
    isVisibleRef.current = isVisible
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isVisible])

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
    const onFocusPane = (event: Event): void => {
      const detail = (event as CustomEvent<FocusTerminalPaneDetail | undefined>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getPanes().find((candidate) => candidate.id === detail.paneId)
      if (!pane) {
        return
      }
      manager.setActivePane(pane.id, { focus: true })
    }
    window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
    return () => window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
  }, [tabId, managerRef])

  // Why: sidebar open/close toggles dispatch SYNC_FIT_PANES_EVENT from a
  // useLayoutEffect (pre-paint, same frame as the width change) so the
  // terminal fits synchronously with the new container size, eliminating the
  // ~16ms "old cols, new container width" flash that a deferred
  // ResizeObserver rAF would otherwise produce. xterm's terminal.resize()
  // natively preserves viewportY across reflows (verified in
  // scroll-reflow.test.ts "reference: undisturbed"), so a bare fitAllPanes()
  // is all we need — no capture/restore dance. The subsequent per-pane
  // ResizeObserver rAF and the 150ms debounced global fit become no-ops
  // because proposeDimensions() will match current cols/rows (early-return
  // branch in safeFit). Listener is global (not gated on isVisible/isActive)
  // so background tabs also fit, keeping their scroll position intact for
  // when the user switches back.
  useEffect(() => {
    const onSyncFit = (): void => {
      managerRef.current?.fitAllPanes()
    }
    window.addEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    return () => {
      window.removeEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    }
  }, [managerRef])

  useEffect(() => {
    if (!isVisible) {
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
        // Why: apply the same epoch-based deduplication as the isActive
        // effect's rAF path.  Read the current epoch at fire time (not a
        // captured value) because the ResizeObserver persists across the
        // activation.  Dimension changes (e.g. window resize) bypass the
        // dedup so legitimate refits are never suppressed.
        const currentEpoch = fitEpochRef.current
        const dimensionsChanged = hasDimensionsChanged(manager)
        if (!dimensionsChanged && fitRanForEpochRef.current >= currentEpoch) {
          return
        }
        fitRanForEpochRef.current = currentEpoch
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
  }, [isVisible])

  // Why: only the active tab's terminal should process file drops. Registering
  // a listener per mounted tab causes a MaxListenersExceededWarning when 11+
  // tabs are open. Gating on isActive ensures at most one listener exists.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFileDrop((data) => {
      if (data.target !== 'terminal') {
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
  }, [isActive, managerRef, paneTransportsRef])
}
