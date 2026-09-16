import { useCallback, useEffect, useLayoutEffect } from 'react'
import { useAppStore } from '../../store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
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
import { shutdownBufferCaptures } from './shutdown-buffer-captures'
import { captureTerminalShutdownLayout } from './terminal-shutdown-layout-capture'
import { shouldPreserveTerminalScrollbackBuffers } from '../../../../shared/workspace-session-terminal-buffers'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

export function useTerminalPaneTitleEffects(controller: TerminalPaneCloseController): void {
  const {
    clearTerminalPaneUnread,
    clearTerminalTabUnread,
    clearWorktreeUnread,
    clearedScrollbackLeafIdsRef,
    containerRef,
    expandedPaneId,
    expandedPaneIdRef,
    isolatedPaneKey,
    isVisible,
    managerRef,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    paneTitlesRef,
    paneTransportsRef,
    renamingPaneId,
    renameInputRef,
    renameUserRequestedBlurCommitRef,
    sessionRestoredBannerPaneIds,
    setPaneTitleOverlayRects,
    setSessionRestoredBannerPaneIds,
    setTabLayout,
    shouldMeasureHiddenStartup,
    tabId,
    worktreeId
  } = controller

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      clearTerminalTabUnread(tabId)
      clearWorktreeUnread(worktreeId)
      const paneElement =
        event.target instanceof Element ? event.target.closest('.pane[data-leaf-id]') : null
      const leafId = paneElement?.getAttribute('data-leaf-id')
      if (leafId) {
        clearTerminalPaneUnread(makePaneKey(tabId, leafId))
      }
    }
    container.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => container.removeEventListener('pointerdown', onPointerDown, { capture: true })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [tabId, worktreeId, clearTerminalTabUnread, clearTerminalPaneUnread, clearWorktreeUnread])

  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (manager) {
      applyTerminalPaneAttentionToManager(manager, tabId)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [tabId])
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    isVisible,
    shouldMeasureHiddenStartup
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [])

  useLayoutEffect(() => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects(clearPaneTitleOverlayRects)
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    syncPaneTitleOverlayRects
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [paneCount])

  useEffect(() => {
    const captureBuffers = (options?: { includeLocalBuffers?: boolean }): void => {
      const manager = managerRef.current
      const container = containerRef.current
      if (!manager || !container) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }
      const state = useAppStore.getState()
      const existing = state.terminalLayoutsByTabId[tabId]
      const includeLocalBuffers = options?.includeLocalBuffers ?? true
      const shouldCaptureScrollbackBuffers = includeLocalBuffers
        ? true
        : shouldPreserveTerminalScrollbackBuffers(worktreeId, state.repos)
      const layout = captureTerminalShutdownLayout({
        manager,
        container,
        expandedPaneId: expandedPaneIdRef.current,
        paneTransports: paneTransportsRef.current,
        paneTitlesByPaneId: paneTitlesRef.current,
        existingLayout: existing,
        captureBuffers: shouldCaptureScrollbackBuffers,
        clearedScrollbackLeafIds: clearedScrollbackLeafIdsRef.current
      })
      setTabLayout(tabId, layout)
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [tabId, worktreeId, setTabLayout])

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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [renamingPaneId])
}
