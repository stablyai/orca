import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-tab-open'
import { resolvePaneWslDistro } from './terminal-pane-wsl-distro'
import { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'
import {
  terminalHttpLinkActionDestinationsFor,
  getTerminalFileOpenHint,
  getTerminalUrlOpenHint,
  terminalUrlOpenHintOptionsFor
} from './terminal-link-open-hints'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import type { TerminalHttpLinkActionDestinations } from './terminal-url-link-hit-testing'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import { registerRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { normalizeTerminalLayoutSnapshot } from './layout-serialization'
import { applyTerminalAppearance } from './terminal-appearance'
import { createTerminalPanePtyDeps } from './terminal-pane-pty-deps'
import type { DeferredSplitPaneHandoffHandle } from './deferred-split-pane-handoff'
import {
  hydrateTerminalScrollbackRefs,
  resolvePaneLinkCwd,
  resolveQueuedInitialCwd,
  resolveTerminalHomePathFromEnv,
  extractUncHost
} from './terminal-pane-lifecycle-primitives'

export type TerminalPaneMountPreparation = {
  container: HTMLDivElement
  expandedStyleSnapshots: Map<HTMLElement, { display: string; flex: string }>
  paneTransports: UseTerminalPaneLifecycleDeps['paneTransportsRef']['current']
  panePtyBindings: UseTerminalPaneLifecycleDeps['panePtyBindingsRef']['current']
  worktreePath: string
  defaultTabCwd: string
  startupCwd: string
  terminalHomePath: string | null
  wslDistro: string | null
  startupWithSetupSplitWait: PtyConnectionDeps['startup']
  ptyDeps: PtyConnectionDeps
  deferredSplitHandoffs: Map<number, DeferredSplitPaneHandoffHandle>
  unregisterRuntimeTab: () => void
  fileOpenLinkHint: string
  getPaneLinkCwd: (paneId: number) => string
  getUrlOpenLinkHint: (paneId: number) => string
  getHttpLinkSourceOwnerForPane: (
    paneId: number
  ) => ReturnType<typeof resolveTerminalHttpLinkSourceOwner>
  canOpenOwnedBrowserForPane: (paneId: number) => boolean
  getHttpLinkActionDestinations: (paneId: number) => TerminalHttpLinkActionDestinations
  getLinkActionContext: (paneId: number) => TerminalLinkActionContext | null
  linkDeps: LinkHandlerDeps
  queueResizeAll: (focusActive: boolean) => void
  cancelResizeAll: () => void
  syncCanExpandState: () => void
  syncPaneCount: () => void
  syncPaneLayoutRevision: () => void
  initialLayoutHadBuffers: boolean
  osc7UncHost: string | null
  applyAppearance: (manager: PaneManager) => void
}

export function prepareTerminalPaneMount(
  deps: UseTerminalPaneLifecycleDeps,
  refs: TerminalPaneLifecycleRefs,
  mountFollowsTerminalPark: boolean
): TerminalPaneMountPreparation | null {
  const { containerRef, expandedStyleSnapshotRef, paneTransportsRef, panePtyBindingsRef } = deps
  const container = containerRef.current
  if (!container) {
    return null
  }
  const expandedStyleSnapshots = expandedStyleSnapshotRef.current
  const paneTransports = paneTransportsRef.current
  const panePtyBindings = panePtyBindingsRef.current
  const worktreePath =
    useAppStore
      .getState()
      .allWorktrees()
      .find((candidate) => candidate.id === deps.worktreeId)?.path ??
    deps.cwd ??
    ''
  const defaultTabCwd = deps.cwd ?? worktreePath
  const initialCwdResolution = resolveQueuedInitialCwd(
    refs.queuedInitialCwdRef.current,
    () => useAppStore.getState().consumeTabInitialCwd(deps.tabId),
    defaultTabCwd
  )
  refs.queuedInitialCwdRef.current = initialCwdResolution.queuedInitialCwd
  const startupCwd = initialCwdResolution.startupCwd
  const terminalHomePath = resolveTerminalHomePathFromEnv(deps.startup?.env)
  const wslDistro = getConnectionId(deps.worktreeId)
    ? null
    : resolvePaneWslDistro(useAppStore.getState(), deps.worktreeId, worktreePath)
  const getPaneLinkCwd = (paneId: number): string =>
    resolvePaneLinkCwd(deps.paneCwdRef.current, paneId, startupCwd)
  const getHttpLinkSourceOwnerForPane = (
    paneId: number
  ): ReturnType<typeof resolveTerminalHttpLinkSourceOwner> =>
    resolveTerminalHttpLinkSourceOwner(paneTransports.get(paneId))
  const canOpenOwnedBrowserForPane = (paneId: number): boolean => {
    const sourceOwner = getHttpLinkSourceOwnerForPane(paneId)
    if (sourceOwner.kind === 'runtime') {
      return canOpenWorkspaceBrowserTabOnRuntime(
        useAppStore.getState(),
        deps.worktreeId,
        sourceOwner.runtimeEnvironmentId
      )
    }
    return (
      sourceOwner.kind === 'ssh' &&
      canOpenWorkspaceBrowserTabOnSsh(
        useAppStore.getState(),
        deps.worktreeId,
        sourceOwner.connectionId
      )
    )
  }
  const getHttpLinkActionDestinations = (paneId: number): TerminalHttpLinkActionDestinations =>
    terminalHttpLinkActionDestinationsFor(
      deps.settingsRef.current,
      getHttpLinkSourceOwnerForPane(paneId),
      canOpenOwnedBrowserForPane(paneId)
    )
  const getLinkActionContext = (paneId: number): TerminalLinkActionContext | null => {
    if (deps.settingsRef.current?.terminalLinkActionPopoverEnabled === false) {
      return null
    }
    const pane = deps.managerRef.current?.getPanes().find((candidate) => candidate.id === paneId)
    const pointerGesture = refs.linkPointerGesturesRef.current.get(paneId)
    const suppression =
      refs.httpLinkClickFallbackDisposablesRef.current.get(paneId)?.ptyMouseSuppression
    if (!pane || !pointerGesture || !suppression) {
      return null
    }
    return {
      paneId,
      pointerGesture,
      claimPtyMouse: suppression.claimAction,
      request: deps.requestTerminalLinkAction,
      focusTerminal: () => pane.terminal.focus()
    }
  }
  const pathExistsCache = new Map<string, boolean>()
  const linkDeps: LinkHandlerDeps = {
    worktreeId: deps.worktreeId,
    worktreePath,
    startupCwd,
    getPaneLinkCwd,
    terminalHomePath,
    wslDistro,
    managerRef: deps.managerRef,
    linkProviderDisposablesRef: refs.linkProviderDisposablesRef,
    pathExistsCache,
    getRuntimeEnvironmentIdForPane: (paneId) => {
      const sourceOwner = getHttpLinkSourceOwnerForPane(paneId)
      return sourceOwner.kind === 'runtime' ? sourceOwner.runtimeEnvironmentId : null
    },
    getLinkActionContext
  }
  let resizeRaf: number | null = null
  const queueResizeAll = (focusActive: boolean): void => {
    if (resizeRaf !== null) {
      cancelAnimationFrame(resizeRaf)
    }
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null
      const manager = deps.managerRef.current
      if (!manager) {
        return
      }
      if (focusActive) {
        fitAndFocusPanes(manager)
      } else {
        fitPanes(manager)
      }
    })
  }
  const cancelResizeAll = (): void => {
    if (resizeRaf !== null) {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = null
    }
  }
  const syncCanExpandState = (): void => {
    deps.setTabCanExpandPane(deps.tabId, (deps.managerRef.current?.getPanes().length ?? 1) > 1)
  }
  const syncPaneCount = (): void => {
    deps.setPaneCount(deps.managerRef.current?.getPanes().length ?? 0)
  }
  const syncPaneLayoutRevision = (): void => {
    deps.setPaneLayoutRevision((revision) => revision + 1)
  }
  const normalizedInitialLayout = normalizeTerminalLayoutSnapshot(deps.initialLayoutRef.current)
  if (normalizedInitialLayout.changed) {
    deps.initialLayoutRef.current = normalizedInitialLayout.snapshot
    useAppStore.getState().setTabLayout(deps.tabId, normalizedInitialLayout.snapshot)
  }
  const initialLayoutHadBuffers = Boolean(deps.initialLayoutRef.current.buffersByLeafId)
  const hydratedInitialScrollback = hydrateTerminalScrollbackRefs(deps.initialLayoutRef.current)
  if (hydratedInitialScrollback.hydrated) {
    deps.initialLayoutRef.current = hydratedInitialScrollback.layout
  }
  const startupWithSetupSplitWait =
    deps.startup && deps.setupSplit
      ? {
          ...deps.startup,
          waitForSetupSplitDirection: deps.setupSplit.direction
        }
      : deps.startup
  // Numeric pane ids are mount-local; the handle itself is keyed by the
  // durable tab/leaf identity so a whole-tab remount can reclaim it.
  const deferredSplitHandoffs = new Map<number, DeferredSplitPaneHandoffHandle>()
  const ptyDeps = createTerminalPanePtyDeps({
    deps,
    refs,
    startupCwd,
    startupWithSetupSplitWait,
    mountFollowsTerminalPark,
    restoredPtyIdByLeafId: deps.initialLayoutRef.current.ptyIdsByLeafId ?? {},
    deferredSplitHandoffs
  })
  const unregisterRuntimeTab = registerRuntimeTerminalTab({
    tabId: deps.tabId,
    worktreeId: deps.worktreeId,
    getManager: () => deps.managerRef.current,
    getContainer: () => deps.containerRef.current,
    getPtyIdForPane: (paneId) => paneTransports.get(paneId)?.getPtyId() ?? null,
    getTabWideAgentHintLeafId: deps.getTabWideAgentHintLeafId
  })
  const fileOpenLinkHint = getTerminalFileOpenHint()
  const getUrlOpenLinkHint = (paneId: number): string =>
    getTerminalUrlOpenHint({
      ...terminalUrlOpenHintOptionsFor(
        deps.settingsRef.current,
        getHttpLinkSourceOwnerForPane(paneId),
        canOpenOwnedBrowserForPane(paneId)
      ),
      showActions: deps.settingsRef.current?.terminalLinkActionPopoverEnabled !== false
    })
  return {
    container,
    expandedStyleSnapshots,
    paneTransports,
    panePtyBindings,
    worktreePath,
    defaultTabCwd,
    startupCwd,
    terminalHomePath,
    wslDistro,
    startupWithSetupSplitWait,
    ptyDeps,
    deferredSplitHandoffs,
    unregisterRuntimeTab,
    fileOpenLinkHint,
    getPaneLinkCwd,
    getUrlOpenLinkHint,
    getHttpLinkSourceOwnerForPane,
    canOpenOwnedBrowserForPane,
    getHttpLinkActionDestinations,
    getLinkActionContext,
    linkDeps,
    queueResizeAll,
    syncCanExpandState,
    syncPaneCount,
    syncPaneLayoutRevision,
    initialLayoutHadBuffers,
    osc7UncHost: extractUncHost(startupCwd),
    applyAppearance: (manager) => {
      const currentSettings = deps.settingsRef.current
      if (!currentSettings) {
        return
      }
      applyTerminalAppearance(
        manager,
        currentSettings,
        refs.systemPrefersDarkRef.current,
        deps.paneFontSizesRef.current,
        deps.paneTransportsRef.current,
        deps.effectiveMacOptionAsAltRef.current,
        deps.paneMode2031Ref.current,
        deps.paneLastThemeModeRef.current
      )
    },
    cancelResizeAll
  }
}
