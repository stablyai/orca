import { useAppStore } from '@/store'
import { findRegisteredTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { isUnifiedTabPinned } from '@/store/pinned-tab-close-guard'
import {
  captureTerminalSurfaceIdentity,
  isRetainedTerminalSurfaceIdentity,
  type TerminalSurfaceCloseIdentity
} from '../../../../shared/terminal-tab-close'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { retireParkedTerminalLeaf } from './terminal-parked-watcher-registry'
import { collapseParkedTerminalLeaf } from './terminal-parked-pty-watcher'

/** Admission and disposal share one synchronous owner action. */
export function removeTerminalPresentation(
  original: TerminalSurfaceCloseIdentity,
  dispose: (failures: unknown[]) => void
): void {
  const state = useAppStore.getState()
  const current = captureTerminalSurfaceIdentity(
    state,
    original.worktreeId,
    original.tabId,
    original.leafId
  )
  if (!isRetainedTerminalSurfaceIdentity(original, current)) {
    throw new Error('terminal_pane_owner_changed')
  }
  const layout = state.terminalLayoutsByTabId[original.tabId]
  const split = detachTerminalLayoutLeaf(layout, original.leafId)
  if (
    current?.hasLeaf &&
    !split &&
    (isUnifiedTabPinned(state, original.worktreeId, original.tabId) ||
      state.tabsByWorktree[original.worktreeId]?.some(
        (tab) => tab.id === original.tabId && tab.isPinned
      ))
  ) {
    throw new Error('terminal_tab_pinned')
  }
  const retainedPtyIds = new Set(
    Object.entries(layout?.ptyIdsByLeafId ?? {})
      .filter(([leafId]) => leafId !== original.leafId)
      .map(([, ptyId]) => ptyId)
  )
  const paneIds = retireParkedTerminalLeaf(original, retainedPtyIds)
  for (const paneId of paneIds) {
    state.clearRuntimePaneTitle(original.tabId, paneId)
  }
  const failures: unknown[] = []
  try {
    dispose(failures)
    if (current?.hasLeaf) {
      if (split) {
        useAppStore.getState().setTabLayout(original.tabId, split.sourceLayout)
      } else {
        useAppStore.getState().closeTab(original.tabId, {
          reason: 'user',
          captureRecentlyClosed: false,
          localPtyTeardownOwnedExternally: true,
          remoteCloseOwnedByHost: true
        })
      }
    }
  } catch (error) {
    if (failures.length === 0) {
      throw error
    }
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'terminal_tab_close_failed')
  }
}

export function retireTerminalPresentation(original: TerminalSurfaceCloseIdentity): void {
  const mounted = findRegisteredTerminalTab(original.tabId, original.worktreeId)?.tab
  if (mounted) {
    if (!mounted.retirePresentation) {
      throw new Error('runtime_unavailable')
    }
    mounted.retirePresentation(original)
    return
  }
  removeTerminalPresentation(original, () => {
    const state = useAppStore.getState()
    state.retireAgentPaneAuthority(`${original.tabId}:${original.leafId}`)
    collapseParkedTerminalLeaf(original.tabId, original.leafId, original.ptyId ?? undefined)
  })
}
