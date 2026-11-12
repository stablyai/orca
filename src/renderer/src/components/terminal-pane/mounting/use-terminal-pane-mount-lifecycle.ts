import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { getCachedTerminalTabForWorktree } from '../controller/tab-state/terminal-tab-lookup'
import { sanitizeTerminalLayoutPaneTitles } from '../../../../../shared/workspace-layout/terminal-pane-title-sanitization'
import { EMPTY_LAYOUT } from '../layout/empty-terminal-layout'
import {
  startHostTerminalScrollbackHydration,
  type LocalScrollbackSnapshots
} from '@/runtime/hosted-terminals/hydration/host-terminal-scrollback-hydration'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { configureTerminalOutputBacklogCap } from '@/lib/pane-manager/terminal-output/pane-terminal-output-queue-registry'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'
import { e2eConfig } from '@/app-shell/startup/e2e-config'
import { isTerminalTabParked } from '../parking/output-watchers/terminal-parked-watcher-registry'
import { prepareTerminalPaneMount } from './terminal-pane-mount-preparation'
import { createTerminalPaneManagerOptions } from './terminal-pane-manager-options'
import { restoreTerminalPaneLayout } from '../layout/terminal-pane-layout-restore'
import { runTerminalPaneBootstrapSplits } from './terminal-pane-mount-bootstrap'
import { runBootstrapSplitInMain } from '../layout/split/terminal-pane-bootstrap-split-in-main'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import { cleanupTerminalPaneMount } from './terminal-pane-mount-cleanup'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'

export function useTerminalPaneMountLifecycle(
  deps: UseTerminalPaneLifecycleDeps,
  refs: TerminalPaneLifecycleRefs
) {
  // Read park intent during render before watcher disposal; instance caching becomes stale on cwd changes.
  const mountFollowsTerminalPark = isTerminalTabParked(deps.tabId)
  configureTerminalOutputBacklogCap(deps.settings?.terminalScrollbackRows)

  const latest = useRef(deps)
  const [mount, setMount] = useState<{
    tabId: string
    worktreeId: string
    cwd: typeof deps.cwd
    manager: PaneManager | null
    phase: 'local' | 'host' | 'ready'
    failure?: { error: unknown }
  } | null>(null)
  const matches =
    mount?.tabId === deps.tabId && mount.worktreeId === deps.worktreeId && mount.cwd === deps.cwd
  const manager = matches && mount.manager === deps.managerRef.current ? mount.manager : null
  const phase = manager ? 'ready' : matches && mount.phase === 'host' ? 'host' : 'local'
  useLayoutEffect(() => {
    if (latest.current.tabId !== deps.tabId || latest.current.worktreeId !== deps.worktreeId) {
      deps.initialLayoutRef.current = EMPTY_LAYOUT
    }
    latest.current = deps
  })
  useEffect(() => {
    let live = true
    let dispose: (() => void) | undefined
    const { tabId, worktreeId, cwd } = deps
    const isCurrent = (): boolean =>
      live &&
      latest.current.tabId === tabId &&
      latest.current.worktreeId === worktreeId &&
      latest.current.cwd === cwd &&
      Boolean(
        getCachedTerminalTabForWorktree(useAppStore.getState().tabsByWorktree, worktreeId, tabId)
      )
    const commit = (snapshots: LocalScrollbackSnapshots): void => {
      const current = latest.current
      const state = useAppStore.getState()
      if (!isCurrent()) {
        return
      }
      const tab = getCachedTerminalTabForWorktree(state.tabsByWorktree, worktreeId, tabId)
      const layout = state.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const retainedInlineLayout = current.initialLayoutRef.current
      current.initialLayoutRef.current = tab
        ? sanitizeTerminalLayoutPaneTitles(layout, tab)
        : layout
      dispose = mountTerminalPane(
        current,
        refs,
        mountFollowsTerminalPark,
        snapshots,
        retainedInlineLayout
      )
      if (current.managerRef.current) {
        setMount({ tabId, worktreeId, cwd, manager: current.managerRef.current, phase: 'ready' })
      }
    }
    const pending = startHostTerminalScrollbackHydration(
      tabId,
      worktreeId,
      undefined,
      isCurrent,
      commit
    )
    const retire = pending?.retire
    if (pending) {
      setMount({ tabId, worktreeId, cwd, manager: null, phase: 'local' })
      void pending.ready.catch((error) => {
        if (isCurrent()) {
          setMount({ tabId, worktreeId, cwd, manager: null, phase: 'local', failure: { error } })
        }
      })
      void pending.local.then(
        (needsHost) => {
          if (isCurrent() && needsHost) {
            setMount({ tabId, worktreeId, cwd, manager: null, phase: 'host' })
          }
        },
        () => {}
      )
    } else {
      commit({})
    }
    return () => {
      live = false
      retire?.()
      dispose?.()
    }
    // Each resource transaction follows the manager identity; the commit reads live preferences.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.tabId, deps.worktreeId, deps.cwd])
  if (matches && mount.failure) {
    throw mount.failure.error
  }
  return { manager, phase }
}

function mountTerminalPane(
  deps: UseTerminalPaneLifecycleDeps,
  refs: TerminalPaneLifecycleRefs,
  mountFollowsTerminalPark: boolean,
  snapshots: LocalScrollbackSnapshots,
  retainedInlineLayout: UseTerminalPaneLifecycleDeps['initialLayoutRef']['current']
): (() => void) | undefined {
  const preparation = prepareTerminalPaneMount(
    deps,
    refs,
    mountFollowsTerminalPark,
    snapshots,
    retainedInlineLayout
  )
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
      queueResizeAll,
      detachPaneToNewTab: deps.detachPaneToNewTab
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
}
