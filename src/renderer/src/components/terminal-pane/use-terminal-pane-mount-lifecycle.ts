import { useEffect } from 'react'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { configureTerminalOutputBacklogCap } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { e2eConfig } from '@/lib/e2e-config'
import { useTerminalParkMountIntent } from './use-terminal-park-mount-intent'
import { prepareTerminalPaneMount } from './terminal-pane-mount-preparation'
import { createTerminalPaneManagerOptions } from './terminal-pane-manager-options'
import { restoreTerminalPaneLayout } from './terminal-pane-layout-restore'
import { runTerminalPaneBootstrapSplits } from './terminal-pane-mount-bootstrap'
import { runBootstrapSplitInMain } from './terminal-pane-bootstrap-split-in-main'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import { cleanupTerminalPaneMount } from './terminal-pane-mount-cleanup'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'

export function useTerminalPaneMountLifecycle(
  deps: UseTerminalPaneLifecycleDeps,
  refs: TerminalPaneLifecycleRefs
): void {
  const mountFollowsTerminalPark = useTerminalParkMountIntent(deps.tabId)
  configureTerminalOutputBacklogCap(deps.settings?.terminalScrollbackRows)

  useEffect(() => {
    const preparation = prepareTerminalPaneMount(deps, refs, mountFollowsTerminalPark)
    if (!preparation) {
      return
    }
    const {
      container,
      deferredSplitHandoffs,
      expandedStyleSnapshots,
      ptyDeps,
      unregisterRuntimeTab
    } = preparation
    let shouldPersistLayout = false
    const releaseWebviewDragPassthrough: { current: (() => void) | null } = {
      current: null
    }
    const queueResizeAll = preparation.queueResizeAll
    const managerContext = {
      deps,
      refs,
      ptyDeps,
      deferredSplitHandoffs,
      // Preserve startup identity before bootstrap mutates ptyDeps.startup, so ownership checks compare the queued object.
      startup: deps.startup,
      defaultTabCwd: preparation.defaultTabCwd,
      startupCwd: preparation.startupCwd,
      worktreePath: preparation.worktreePath,
      terminalHomePath: preparation.terminalHomePath,
      wslDistro: preparation.wslDistro,
      linkDeps: preparation.linkDeps,
      fileOpenLinkHint: preparation.fileOpenLinkHint,
      getPaneLinkCwd: preparation.getPaneLinkCwd,
      getUrlOpenLinkHint: preparation.getUrlOpenLinkHint,
      getHttpLinkSourceOwnerForPane: preparation.getHttpLinkSourceOwnerForPane,
      getHttpLinkActionDestinations: preparation.getHttpLinkActionDestinations,
      getLinkActionContext: preparation.getLinkActionContext,
      canOpenOwnedBrowserForPane: preparation.canOpenOwnedBrowserForPane,
      queueResizeAll,
      syncPaneCount: preparation.syncPaneCount,
      syncPaneLayoutRevision: preparation.syncPaneLayoutRevision,
      syncCanExpandState: preparation.syncCanExpandState,
      applyAppearance: preparation.applyAppearance,
      requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference,
      onShowSessionRestoredBanner: deps.onShowSessionRestoredBanner,
      releaseWebviewDragPassthrough: releaseWebviewDragPassthrough,
      shouldPersistLayout: () => shouldPersistLayout,
      osc7UncHost: preparation.osc7UncHost
    }
    const manager = new PaneManager(container, createTerminalPaneManagerOptions(managerContext))
    deps.managerRef.current = manager
    if (e2eConfig.exposeStore) {
      window.__paneManagers = window.__paneManagers ?? new Map()
      window.__paneManagers.set(deps.tabId, manager)
    }
    restoreTerminalPaneLayout({
      manager,
      deps,
      refs,
      ptyDeps,
      initialLayoutHadBuffers: preparation.initialLayoutHadBuffers
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      runBootstrapSplitInMain({
        manager,
        worktreeId: deps.worktreeId,
        tabId: deps.tabId,
        ptyDeps,
        issueCommandSplit: deps.issueCommandSplit,
        isActive: deps.isActive
      })
    } else {
      runTerminalPaneBootstrapSplits({
        manager,
        ptyDeps,
        issueCommandSplit: deps.issueCommandSplit,
        isActive: deps.isActive
      })
    }
    shouldPersistLayout = true
    preparation.syncCanExpandState()
    preparation.syncPaneCount()
    preparation.applyAppearance(manager)
    queueResizeAll(deps.isActive)
    deps.persistLayoutSnapshot()
    scheduleRuntimeGraphSync()
    const removeMountEvents = installTerminalPaneMountEvents({
      manager,
      deps: {
        tabId: deps.tabId,
        worktreeId: deps.worktreeId,
        isActive: deps.isActive,
        managerRef: deps.managerRef,
        showPaneTitle: deps.showPaneTitle,
        persistLayoutSnapshot: deps.persistLayoutSnapshot,
        syncCanExpandState: preparation.syncCanExpandState,
        queueResizeAll
      },
      ptyDeps
    })
    return () => {
      removeMountEvents()
      cleanupTerminalPaneMount({
        manager,
        deps,
        refs,
        deferredSplitHandoffs,
        expandedStyleSnapshots,
        unregisterRuntimeTab,
        cancelResize: preparation.cancelResizeAll
      })
      releaseWebviewDragPassthrough.current?.()
      releaseWebviewDragPassthrough.current = null
    }
    // The manager follows tab/cwd identity; live settings are handled by sibling effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.tabId, deps.cwd])
}
