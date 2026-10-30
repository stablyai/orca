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
    let inputFailure: unknown
    const finish = (cleanup: () => void): void => {
      try {
        cleanup()
      } catch (error) {
        inputFailure ??= error
      }
    }
    const isDetachedToTab = closedPane?.reason === 'detach'
    const isRetiredSurface = closedPane?.reason === 'retire'
    const binding = panePtyBindingsRef.current.get(paneId)
    panePtyBindingsRef.current.delete(paneId)
    const transport = paneTransportsRef.current.get(paneId)
    paneTransportsRef.current.delete(paneId)
    const closedPtyId = transport?.getPtyId() ?? null
    const deferredSplitHandoff = context.deferredSplitHandoffs.get(paneId)
    context.deferredSplitHandoffs.delete(paneId)
    const replaced = (): boolean =>
      paneTransportsRef.current.has(paneId) || panePtyBindingsRef.current.has(paneId)
    const disposables = [
      refs.linkProviderDisposablesRef.current,
      refs.terminalHandleLinkDisposablesRef.current,
      refs.linkifierClickPrimingDisposablesRef.current,
      refs.fileLinkClickFallbackDisposablesRef.current,
      refs.selectionDisposablesRef.current,
      refs.nativeCopyDisposablesRef.current,
      refs.imeCompositionDisposablesRef.current,
      refs.imeNativeTextForwarderDisposablesRef.current,
      refs.osc52DisposablesRef.current,
      refs.osc7DisposablesRef.current,
      refs.mouseHideDisposablesRef.current,
      refs.httpLinkClickFallbackDisposablesRef.current
    ].map((map) => {
      const retired = map.get(paneId)
      map.delete(paneId)
      return retired
    })
    const gesture = refs.linkPointerGesturesRef.current.get(paneId)
    refs.linkPointerGesturesRef.current.delete(paneId)
    const timer = refs.selectionCaptureTimersRef.current.get(paneId)
    refs.selectionCaptureTimersRef.current.delete(paneId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
    }
    paneMode2031Ref.current.delete(paneId)
    paneKittyKeyboardModesRef.current.delete(paneId)
    paneLastThemeModeRef.current.delete(paneId)
    paneCwdRef.current.delete(paneId)
    paneFontSizesRef.current.delete(paneId)
    replayingPanesRef.current.delete(paneId)
    refs.restoredViewportBlankingPanesRef.current.delete(paneId)
    finish(() => binding?.dispose())
    for (const disposable of disposables) {
      finish(() => disposable?.dispose())
    }
    finish(() => gesture?.dispose())
    finish(() => onPtyRecoveryStateRef?.current?.(paneId, null))
    const leafId = closedPane?.leafId
    finish(() => {
      if (replaced()) {
        return
      }
      const terminalTab = useAppStore
        .getState()
        .tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
      if (!isDetachedToTab && shouldClearLaunchAgentForClosedPane(terminalTab, closedPtyId)) {
        useAppStore.getState().clearTabLaunchAgent(tabId)
      }
    })
    finish(() => {
      if (deferredSplitHandoff) {
        clearDeferredSplitPaneHandoff(deferredSplitHandoff)
      } else if (leafId && !replaced()) {
        discardDeferredSplitPaneHandoffForKey(makePaneKey(tabId, leafId))
      }
    })
    finish(() => {
      if (replaced()) {
        return
      }
      if (leafId && isRetiredSurface) {
        retireMountedTerminalPaneSurface({
          paneKey: makePaneKey(tabId, leafId),
          leafId,
          paneId,
          tabId,
          ptyId: closedPtyId,
          retireAgentPaneAuthority: useAppStore.getState().retireAgentPaneAuthority,
          syncPanePtyLayoutBinding: (id, pty) => {
            if (!replaced()) {
              syncPanePtyLayoutBinding(id, pty)
            }
          },
          syncPanePtyLayoutBindingForLeaf: syncPanePtyLayoutBindingForLeaf
            ? (leaf, pty, id) => {
                if (!replaced()) {
                  syncPanePtyLayoutBindingForLeaf(leaf, pty, id)
                }
              }
            : undefined,
          clearExitedPanePtyLayoutBindingForLeaf: clearExitedPanePtyLayoutBindingForLeaf
            ? (leaf, pty) => {
                if (!replaced()) {
                  clearExitedPanePtyLayoutBindingForLeaf(leaf, pty)
                }
              }
            : undefined,
          clearTabPtyId: (tab, pty) => {
            if (!replaced()) {
              clearTabPtyId(tab, pty)
            }
          }
        })
      } else if (leafId && !isDetachedToTab) {
        useAppStore.getState().retireAgentPaneAuthority(makePaneKey(tabId, leafId))
      }
    })
    if (transport) {
      if (isDetachedToTab || isRetiredSurface) {
        finish(() => transport.detach?.({ preserveExitObserver: false }))
      } else {
        finish(() => {
          if (replaced()) {
            return
          }
          const ptyId = suppressIntentionalPaneCloseExit(
            transport,
            useAppStore.getState().suppressPtyExit
          )
          if (ptyId && !replaced()) {
            if (leafId && clearExitedPanePtyLayoutBindingForLeaf) {
              clearExitedPanePtyLayoutBindingForLeaf(leafId, ptyId)
            } else if (leafId) {
              syncPanePtyLayoutBindingForLeaf?.(leafId, null, paneId)
            } else {
              syncPanePtyLayoutBinding(paneId, null)
            }
            if (!replaced()) {
              clearTabPtyId(tabId, ptyId)
            }
          }
        })
        finish(() => transport.destroy?.())
      }
    }
    if (replaced()) {
      if (inputFailure !== undefined) {
        throw inputFailure
      }
      return
    }
    finish(() => clearRuntimePaneTitle(tabId, paneId))
    if (replaced()) {
      if (inputFailure !== undefined) {
        throw inputFailure
      }
      return
    }
    finish(() =>
      setPaneTitles((current) => {
        if (!(paneId in current)) {
          return current
        }
        const next = { ...current }
        delete next[paneId]
        return next
      })
    )
    if (!replaced() && paneId in paneTitlesRef.current) {
      const next = { ...paneTitlesRef.current }
      delete next[paneId]
      paneTitlesRef.current = next
    }
    finish(() => {
      if (!replaced()) {
        setRenamingPaneId((current) => (current === paneId ? null : current))
      }
    })
    finish(() => setPaneCount(managerRef.current?.getPanes().length ?? 0))
    const activePane = managerRef.current?.getActivePane()
    if (activePane && !replaced()) {
      reportActiveRendererPtyForPane(paneTransportsRef.current, activePane.id)
      const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {}
      if (!replaced()) {
        updateTabTitle(tabId, resolveTabTitleAfterPaneClose(paneTitles, activePane.id))
      }
    }
    finish(() => scheduleRuntimeGraphSync())
    if (inputFailure !== undefined) {
      throw inputFailure
    }
  }
}
