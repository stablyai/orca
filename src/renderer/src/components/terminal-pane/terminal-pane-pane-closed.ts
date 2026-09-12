import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import {
  resolveTabTitleAfterPaneClose,
  shouldClearLaunchAgentForClosedPane
} from './terminal-pane-close-identity'
import { reportActiveRendererPtyForPane } from './terminal-pane-lifecycle-primitives'
import {
  retireMountedTerminalPaneSurface,
  suppressIntentionalPaneCloseExit
} from './terminal-pane-lifecycle-close'
import {
  clearDeferredSplitPaneHandoff,
  discardDeferredSplitPaneHandoffForKey
} from './deferred-split-pane-handoff'
import type { PaneClosedHandlerContext } from './terminal-pane-mount-context'

export function createTerminalPaneClosedHandler(
  context: Omit<PaneClosedHandlerContext, 'paneId' | 'closedPane'>
): (paneId: number, closedPane?: PaneClosedHandlerContext['closedPane']) => void {
  return (paneId, closedPane) => {
    const { deps, refs } = context
    const {
      tabId,
      worktreeId,
      onPtyRecoveryStateRef,
      paneMode2031Ref,
      paneKittyKeyboardModesRef,
      paneLastThemeModeRef,
      paneCwdRef,
      paneTransportsRef,
      panePtyBindingsRef,
      paneFontSizesRef,
      replayingPanesRef,
      clearRuntimePaneTitle,
      syncPanePtyLayoutBinding,
      syncPanePtyLayoutBindingForLeaf,
      clearExitedPanePtyLayoutBindingForLeaf,
      clearTabPtyId,
      setPaneTitles,
      paneTitlesRef,
      setRenamingPaneId,
      setPaneCount,
      updateTabTitle,
      managerRef
    } = deps
    onPtyRecoveryStateRef?.current?.(paneId, null)
    const isDetachedToTab = closedPane?.reason === 'detach'
    const isRetiredSurface = closedPane?.reason === 'retire'
    disposeMapEntry(refs.linkProviderDisposablesRef.current, paneId)
    disposeMapEntry(refs.terminalHandleLinkDisposablesRef.current, paneId)
    disposeMapEntry(refs.linkifierClickPrimingDisposablesRef.current, paneId)
    const gesture = refs.linkPointerGesturesRef.current.get(paneId)
    gesture?.dispose()
    refs.linkPointerGesturesRef.current.delete(paneId)
    disposeMapEntry(refs.fileLinkClickFallbackDisposablesRef.current, paneId)
    disposeMapEntry(refs.httpLinkClickFallbackDisposablesRef.current, paneId)
    disposeMapEntry(refs.selectionDisposablesRef.current, paneId)
    disposeMapEntry(refs.imeCompositionDisposablesRef.current, paneId)
    disposeMapEntry(refs.imeNativeTextForwarderDisposablesRef.current, paneId)
    const timer = refs.selectionCaptureTimersRef.current.get(paneId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      refs.selectionCaptureTimersRef.current.delete(paneId)
    }
    paneMode2031Ref.current.delete(paneId)
    paneKittyKeyboardModesRef.current.delete(paneId)
    paneLastThemeModeRef.current.delete(paneId)
    disposeMapEntry(refs.osc52DisposablesRef.current, paneId)
    disposeMapEntry(refs.osc7DisposablesRef.current, paneId)
    paneCwdRef.current.delete(paneId)
    disposeMapEntry(refs.mouseHideDisposablesRef.current, paneId)

    const transport = paneTransportsRef.current.get(paneId)
    const closedPtyId = transport?.getPtyId() ?? null
    const terminalTab = useAppStore
      .getState()
      .tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
    if (!isDetachedToTab && shouldClearLaunchAgentForClosedPane(terminalTab, closedPtyId)) {
      useAppStore.getState().clearTabLaunchAgent(tabId)
    }
    const binding = panePtyBindingsRef.current.get(paneId)
    binding?.dispose()
    panePtyBindingsRef.current.delete(paneId)
    const leafId = closedPane?.leafId
    const deferredSplitHandoff = context.deferredSplitHandoffs.get(paneId)
    if (deferredSplitHandoff) {
      // Explicit pane removal is terminal for the split intent; only a
      // whole-tab remount is allowed to retain this record.
      clearDeferredSplitPaneHandoff(deferredSplitHandoff)
      context.deferredSplitHandoffs.delete(paneId)
    } else if (leafId) {
      // A close callback can outlive its mount-local numeric handle; the
      // durable leaf key still identifies the deferred split to discard.
      discardDeferredSplitPaneHandoffForKey(makePaneKey(tabId, leafId))
    }
    if (leafId && isRetiredSurface) {
      retireMountedTerminalPaneSurface({
        paneKey: makePaneKey(tabId, leafId),
        leafId,
        paneId,
        tabId,
        ptyId: closedPtyId,
        retireAgentPaneAuthority: useAppStore.getState().retireAgentPaneAuthority,
        syncPanePtyLayoutBinding,
        syncPanePtyLayoutBindingForLeaf,
        clearExitedPanePtyLayoutBindingForLeaf,
        clearTabPtyId,
        ...(transport ? { transport } : {})
      })
    } else if (leafId && !isDetachedToTab) {
      useAppStore.getState().retireAgentPaneAuthority(makePaneKey(tabId, leafId))
    }
    if (transport && !isRetiredSurface) {
      if (isDetachedToTab) {
        transport.detach?.({ preserveExitObserver: false })
      } else {
        const ptyId = suppressIntentionalPaneCloseExit(
          transport,
          useAppStore.getState().suppressPtyExit
        )
        if (ptyId) {
          if (leafId && clearExitedPanePtyLayoutBindingForLeaf) {
            clearExitedPanePtyLayoutBindingForLeaf(leafId, ptyId)
          } else if (leafId) {
            syncPanePtyLayoutBindingForLeaf?.(leafId, null, paneId)
          } else {
            syncPanePtyLayoutBinding(paneId, null)
          }
          clearTabPtyId(tabId, ptyId)
        }
        transport.destroy?.()
      }
      paneTransportsRef.current.delete(paneId)
    }
    clearRuntimePaneTitle(tabId, paneId)
    paneFontSizesRef.current.delete(paneId)
    replayingPanesRef.current.delete(paneId)
    refs.restoredViewportBlankingPanesRef.current.delete(paneId)
    setPaneTitles((current) => {
      if (!(paneId in current)) {
        return current
      }
      const next = { ...current }
      delete next[paneId]
      return next
    })
    if (paneId in paneTitlesRef.current) {
      const next = { ...paneTitlesRef.current }
      delete next[paneId]
      paneTitlesRef.current = next
    }
    setRenamingPaneId((current) => (current === paneId ? null : current))
    setPaneCount(managerRef.current?.getPanes().length ?? 0)
    const activePane = managerRef.current?.getActivePane()
    if (activePane) {
      reportActiveRendererPtyForPane(paneTransportsRef.current, activePane.id)
      const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {}
      updateTabTitle(tabId, resolveTabTitleAfterPaneClose(paneTitles, activePane.id))
    }
    scheduleRuntimeGraphSync()
  }
}

function disposeMapEntry(map: Map<number, { dispose: () => void }>, paneId: number): void {
  map.get(paneId)?.dispose()
  map.delete(paneId)
}
