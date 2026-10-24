import { vi, type Mock } from 'vitest'
import { renderHook } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { ImageAddon } from '@xterm/addon-image'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import { retireManagedPanePreservingPty } from '@/lib/pane-manager/pane-split-close'
import { createTerminalPaneClosedHandler } from './terminal-pane-pane-closed'
import { registerTerminalPaneMount } from './terminal-pane-mount-registration'
import { cleanupTerminalPaneMount } from './terminal-pane-mount-cleanup'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import type { PaneClosedHandlerContext } from './terminal-pane-mount-context'
import { useTerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { PtyTransport } from './pty-transport-types'
import { useAppStore } from '@/store'

export const LEAF = '11111111-1111-4111-8111-111111111111'
export const SIBLING = '22222222-2222-4222-8222-222222222222'

function disposable<T extends { dispose(): void }>(value: T): T {
  return Object.assign(value, { dispose: vi.fn<() => void>() })
}

function pane(id: number, leafId: string): ManagedPaneInternal {
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Expected a valid fixture leaf id')
  }
  const terminal = disposable(new Terminal())
  vi.spyOn(terminal, 'clearSelection').mockImplementation(() => {})
  vi.spyOn(terminal, 'focus').mockImplementation(() => {})
  const container = document.createElement('div')
  container.classList.add('pane')
  container.dataset.leafId = leafId
  return {
    id,
    leafId,
    stablePaneId: leafId,
    terminal,
    container,
    xtermContainer: container,
    linkTooltip: document.createElement('div'),
    terminalGpuAcceleration: 'off',
    gpuRenderingEnabled: false,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null,
    searchAddon: disposable(new SearchAddon()),
    serializeAddon: disposable(new SerializeAddon()),
    unicode11Addon: disposable(new Unicode11Addon()),
    webLinksAddon: disposable(new WebLinksAddon()),
    fitAddon: disposable(new FitAddon()),
    webglAddon: disposable(new WebglAddon()),
    imageAddon: disposable(new ImageAddon()),
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    paneDragCleanup: vi.fn(),
    focusClassSyncCleanup: vi.fn()
  }
}

type MountedOwner = {
  source: ManagedPaneInternal
  other: ManagedPaneInternal
  panes: Map<number, ManagedPaneInternal>
  sourceTransport: PtyTransport
  transports: Map<number, PtyTransport>
  binding: { dispose: Mock }
  bindings: Map<number, { dispose: Mock }>
  link: { dispose: Mock }
  onLayoutChanged: Mock
  manager: PaneManager
  empty: Mock<() => void>
  cancelResize: Mock
  expandedElement: HTMLDivElement
  setPaneCount: UseTerminalPaneLifecycleDeps['setPaneCount']
  unregister: () => void
}

/** Uses the production tree teardown, real pane disposer and real mount closure callback. */
export function mountedOwner(
  split: boolean,
  address = {
    tabId: 'terminal',
    worktreeId: 'wt-1',
    leafId: LEAF,
    ptyId: 'pty-1'
  }
): MountedOwner {
  const source = pane(1, address.leafId)
  const other = pane(2, SIBLING)
  const panes = new Map([[1, source], ...(split ? [[2, other] as const] : [])])
  const sourceTransport: PtyTransport = {
    getPtyId: () => address.ptyId,
    detach: vi.fn(),
    destroy: vi.fn(),
    connect: vi.fn(),
    attach: vi.fn(),
    disconnect: vi.fn(),
    sendInput: () => true,
    sendInputImmediate: () => true,
    resize: () => true,
    isConnected: () => false
  }
  const transports = new Map([[1, sourceTransport]])
  const binding = { dispose: vi.fn() }
  const bindings = new Map([[1, binding]])
  const lifecycleRefs = renderHook(useTerminalPaneLifecycleRefs)
  const refs = lifecycleRefs.result.current
  const ref = <T>() => ({ current: new Map<number, T>() })
  const link = { dispose: vi.fn() }
  refs.linkProviderDisposablesRef.current.set(1, link)
  const state = useAppStore.getState()
  let manager: PaneManager
  const managerRef: { current: PaneManager | null } = { current: null }
  const deps: UseTerminalPaneLifecycleDeps = {
    tabId: address.tabId,
    worktreeId: address.worktreeId,
    managerRef,
    containerRef: { current: null },
    paneTransportsRef: { current: transports },
    panePtyBindingsRef: { current: bindings },
    paneMode2031Ref: ref(),
    paneKittyKeyboardModesRef: ref(),
    paneLastThemeModeRef: ref(),
    paneCwdRef: ref(),
    paneFontSizesRef: ref(),
    replayingPanesRef: refs.replayingPanesRef,
    clearRuntimePaneTitle: state.clearRuntimePaneTitle,
    syncPanePtyLayoutBinding: vi.fn(),
    clearTabPtyId: state.clearTabPtyId,
    setPaneTitles: vi.fn(),
    paneTitlesRef: { current: {} },
    setRenamingPaneId: vi.fn(),
    setPaneCount: vi.fn(),
    setTabPaneExpanded: state.setTabPaneExpanded,
    setTabCanExpandPane: state.setTabCanExpandPane,
    updateTabTitle: state.updateTabTitle,
    persistLayoutSnapshot: vi.fn(),
    getTabWideAgentHintLeafId: () => null,
    isActive: false,
    isVisible: false,
    systemPrefersDark: false,
    settings: null,
    settingsRef: { current: null },
    requestOpenLinksInAppPreference: vi.fn(),
    requestTerminalLinkAction: vi.fn(),
    effectiveMacOptionAsAlt: 'false',
    effectiveMacOptionAsAltRef: { current: 'false' },
    initialLayoutRef: {
      current: {
        root: { type: 'leaf', leafId: address.leafId },
        activeLeafId: address.leafId,
        expandedLeafId: null
      }
    },
    expandedStyleSnapshotRef: { current: new Map() },
    isActiveRef: { current: false },
    isVisibleRef: { current: false },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    consumeSuppressedPtyExit: () => false,
    isPtyShutdownPending: () => false,
    setRuntimePaneTitle: state.setRuntimePaneTitle,
    updateTabPtyId: state.updateTabPtyId,
    markTerminalBell: state.markTerminalBell,
    onShowSessionRestoredBanner: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    setExpandedPane: vi.fn(),
    syncExpandedLayout: vi.fn(),
    showPaneTitle: vi.fn(),
    setPaneLayoutRevision: vi.fn()
  }
  const context: Pick<
    PaneClosedHandlerContext,
    'deps' | 'refs' | 'deferredSplitHandoffs' | 'getOwnedManager'
  > = {
    deps,
    refs,
    deferredSplitHandoffs: new Map(),
    getOwnedManager: () => manager
  }
  const onPaneClosed = createTerminalPaneClosedHandler(context)
  const onLayoutChanged = vi.fn()
  manager = new PaneManager(document.createElement('div'), { linkOpenHint: () => '' })
  vi.spyOn(manager, 'getPanes').mockImplementation(() => [...panes.values()])
  vi.spyOn(manager, 'getActivePane').mockImplementation(() => panes.get(2) ?? panes.get(1) ?? null)
  vi.spyOn(manager, 'retirePanePreservingPty').mockImplementation((id, permanent, failures) =>
    retireManagedPanePreservingPty(
      {
        paneId: id,
        failures,
        activePaneId: 1,
        panes,
        root: document.createElement('div'),
        styleOptions: {},
        managerOptions: { linkOpenHint: () => '', onPaneClosed, onLayoutChanged },
        getDragCallbacks: () => ({
          getPanes: () => panes,
          getRoot: () => source.container,
          getStyleOptions: () => ({}),
          isDestroyed: () => false,
          safeFit: vi.fn(),
          applyPaneOpacity: vi.fn(),
          applyDividerStyles: vi.fn(),
          refitPanesUnder: vi.fn()
        }),
        releasePaneIdentity: vi.fn(),
        setActivePaneId: vi.fn()
      },
      permanent
    )
  )
  vi.spyOn(manager, 'destroy')
  managerRef.current = manager
  const cancelResize = vi.fn()
  const expandedElement = document.createElement('div')
  expandedElement.style.display = 'none'
  const expandedStyleSnapshots = new Map([[expandedElement, { display: 'flex', flex: '1' }]])
  const removeMountEvents = installTerminalPaneMountEvents({
    manager,
    deps: {
      ...deps,
      isActive: false,
      showPaneTitle: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    ptyDeps: { ...deps, mountFollowsTerminalPark: false }
  })
  const empty = vi.fn(() => {
    removeMountEvents()
    cleanupTerminalPaneMount({
      manager,
      deps: context.deps,
      refs: context.refs,
      deferredSplitHandoffs: context.deferredSplitHandoffs,
      expandedStyleSnapshots,
      unregisterRuntimeTab: registration.unregisterRuntimeTab,
      cancelResize,
      permanent: true
    })
  })
  const registration = registerTerminalPaneMount(context, empty)
  registration.setOwnedManager(manager)
  // A null rendering ref does not release the actual mounted owner.
  managerRef.current = null
  return {
    source,
    other,
    panes,
    sourceTransport,
    transports,
    binding,
    bindings,
    link,
    onLayoutChanged,
    manager,
    empty,
    cancelResize,
    expandedElement,
    setPaneCount: deps.setPaneCount,
    unregister: () => {
      removeMountEvents()
      registration.unregisterRuntimeTab()
      manager.destroy()
      lifecycleRefs.unmount()
    }
  }
}
