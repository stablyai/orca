import { useCallback, useEffect, useLayoutEffect } from 'react'
import { useAppStore } from '../../store'
import {
  applyTerminalPaneAttentionToManager,
  subscribeTerminalPaneAttention
} from './terminal-pane-attention-subscriptions'
import {
  pruneSessionRestoredBannerPaneIds,
  syncSessionRestoredBannerTitleSpace
} from './session-restored-banner-pane-state'
import { fitPanes } from './pane-helpers'
import {
  arePaneTitleOverlayRectsEqual,
  clearPaneTitleOverlayRects
} from './pane-title-overlay-rects'
import type { PaneTitleOverlayRect } from './TerminalPaneHeaderOverlay'
import {
  shutdownBufferCaptures,
  type ShutdownBufferCaptureOptions
} from './shutdown-buffer-captures'
import { captureTerminalShutdownLayout } from './terminal-shutdown-layout-capture'
import { resolveLeafScrollbackBuffers } from './leaf-scrollback-resolution'
import { shouldPreserveTerminalScrollbackBuffers } from '../../../../shared/workspace-session-terminal-buffers'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

export function useTerminalPaneTitleEffects(controller: TerminalPaneCloseController): void {
  const {
    clearedScrollbackLeafIdsRef,
    containerRef,
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    managerRef,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    paneTransportsRef,
    renamingPaneId,
    renameInputRef,
    renameUserRequestedBlurCommitRef,
    sessionRestoredBannerPaneIds,
    setPaneTitleOverlayRects,
    setSessionRestoredBannerPaneIds,
    setTabLayout,
    setTabLocalOnlyScrollback,
    shouldMeasureHiddenStartup,
    tabId,
    worktreeId
  } = controller

  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (manager) {
      applyTerminalPaneAttentionToManager(manager, tabId)
    }
  }, [tabId, managerRef])
  useLayoutEffect(() => {
    applyTerminalPaneAttention()
    return subscribeTerminalPaneAttention(tabId, applyTerminalPaneAttention)
  }, [tabId, paneCount, applyTerminalPaneAttention])

  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: manager.getPanes(),
      paneTitles,
      renamingPaneId,
      sessionRestoredBannerPaneIds
    })
    if (needsFit && (isVisible || shouldMeasureHiddenStartup)) {
      fitPanes(manager)
    }
  }, [
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    isVisible,
    shouldMeasureHiddenStartup,
    managerRef
  ])

  const syncPaneTitleOverlayRects = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects(clearPaneTitleOverlayRects)
      return
    }
    const containerRect = container.getBoundingClientRect()
    const nextRects: Record<number, PaneTitleOverlayRect> = {}
    for (const pane of manager.getPanes()) {
      const paneRect = pane.container.getBoundingClientRect()
      if (paneRect.width <= 0 || paneRect.height <= 0) {
        continue
      }
      nextRects[pane.id] = {
        left: paneRect.left - containerRect.left,
        top: paneRect.top - containerRect.top,
        width: paneRect.width
      }
    }
    setPaneTitleOverlayRects((previous) =>
      arePaneTitleOverlayRectsEqual(previous, nextRects) ? previous : nextRects
    )
  }, [containerRef, managerRef, setPaneTitleOverlayRects])

  useLayoutEffect(() => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects(clearPaneTitleOverlayRects)
      return
    }
    // Hidden overlays are display:none; keeping their last rects avoids a forced layout and a pane re-render on every workspace switch.
    if (!isVisible && !shouldMeasureHiddenStartup) {
      return
    }
    let frame: number | null = null
    const scheduleSync = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        frame = null
        syncPaneTitleOverlayRects()
      })
    }
    syncPaneTitleOverlayRects()
    const resizeObserver = new ResizeObserver(scheduleSync)
    resizeObserver.observe(container)
    for (const pane of manager.getPanes()) {
      resizeObserver.observe(pane.container)
    }
    return () => {
      resizeObserver.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    shouldMeasureHiddenStartup,
    syncPaneTitleOverlayRects,
    containerRef,
    managerRef,
    setPaneTitleOverlayRects
  ])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    setSessionRestoredBannerPaneIds((previous) => {
      const next = pruneSessionRestoredBannerPaneIds(previous, manager.getPanes())
      return next === previous ? previous : next
    })
  }, [paneCount, managerRef, setSessionRestoredBannerPaneIds])

  useEffect(() => {
    const captureBuffers = (options?: ShutdownBufferCaptureOptions): void => {
      const manager = managerRef.current
      const state = useAppStore.getState()
      const existing = state.terminalLayoutsByTabId[tabId]
      // Mounting stores the layout; only closing the tab or its workspace removes it.
      if (!manager || !existing) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }
      const includeLocalBuffers = options?.includeLocalBuffers ?? true
      const shouldCaptureScrollbackBuffers = includeLocalBuffers
        ? true
        : shouldPreserveTerminalScrollbackBuffers(worktreeId, state.repos)
      const layout = captureTerminalShutdownLayout({
        manager,
        paneTransports: paneTransportsRef.current,
        existingLayout: existing,
        // Empty mid-replay captures must fall back to the last good shared or local buffer.
        priorBuffersByLeafId: resolveLeafScrollbackBuffers({
          shared: existing,
          localOnly: state.localOnlyScrollbackByTabId[tabId]
        }),
        captureBuffers: shouldCaptureScrollbackBuffers,
        clearedScrollbackLeafIds: clearedScrollbackLeafIdsRef.current
      })
      if (options?.localOnly && layout.buffersByLeafId) {
        // Cold parks are frequent: keep layout structure shared but buffer bytes in the local-only field excluded from remote export.
        const { buffersByLeafId, ...structureOnly } = layout
        setTabLayout(tabId, structureOnly)
        setTabLocalOnlyScrollback(tabId, buffersByLeafId)
      } else {
        setTabLayout(tabId, layout)
        // A shared capture supersedes whatever the last park left behind, so the local copy goes.
        setTabLocalOnlyScrollback(tabId, null)
      }
      for (const pane of panes) {
        clearedScrollbackLeafIdsRef.current.delete(pane.leafId)
      }
    }
    shutdownBufferCaptures.set(tabId, captureBuffers)
    return () => {
      if (shutdownBufferCaptures.get(tabId) === captureBuffers) {
        shutdownBufferCaptures.delete(tabId)
      }
    }
  }, [
    tabId,
    worktreeId,
    setTabLayout,
    setTabLocalOnlyScrollback,
    clearedScrollbackLeafIdsRef,
    managerRef,
    paneTransportsRef
  ])

  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const markPointerBlurIntent = (event: PointerEvent): void => {
      const input = renameInputRef.current
      const target = event.target
      if (input && target instanceof Node && input.contains(target)) {
        return
      }
      renameUserRequestedBlurCommitRef.current = true
    }
    const markKeyboardBlurIntent = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        renameUserRequestedBlurCommitRef.current = true
      }
    }
    document.addEventListener('pointerdown', markPointerBlurIntent, true)
    document.addEventListener('keydown', markKeyboardBlurIntent, true)
    return () => {
      document.removeEventListener('pointerdown', markPointerBlurIntent, true)
      document.removeEventListener('keydown', markKeyboardBlurIntent, true)
    }
  }, [renamingPaneId, renameInputRef, renameUserRequestedBlurCommitRef])
}
