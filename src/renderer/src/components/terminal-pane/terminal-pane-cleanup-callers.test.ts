// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { afterEach, expect, it, vi } from 'vitest'
import { PaneManager, type ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import type { PtyTransport } from './pty-transport-types'
import { cleanupTerminalPaneMount } from './terminal-pane-mount-cleanup'
import { createTerminalPaneClosedHandler } from './terminal-pane-pane-closed'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'

const state = vi.hoisted(() => ({
  tabsByWorktree: {},
  unifiedTabsByWorktree: {},
  runtimePaneTitlesByTabId: {},
  clearTabLaunchAgent: vi.fn(),
  retireAgentPaneAuthority: vi.fn(),
  suppressPtyExit: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('./terminal-parked-tab-watchers', () => ({ captureParkedTerminalPaneCandidates: vi.fn() }))
vi.mock('./terminal-pane-split-request-routing', () => ({
  cancelQueuedTerminalPaneSplitRequests: vi.fn()
}))
vi.mock('./deferred-split-pane-handoff', () => ({
  clearDeferredSplitPaneHandoff: vi.fn(),
  releaseDeferredSplitPaneHandoff: vi.fn(),
  discardDeferredSplitPaneHandoffsForTab: vi.fn(),
  discardDeferredSplitPaneHandoffForKey: vi.fn()
}))
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function fixture() {
  vi.useFakeTimers()
  const events: string[] = []
  const root = document.createElement('div')
  document.body.append(root)
  const terminal = new Terminal({ allowProposedApi: true })
  const pane: ManagedPane = {
    id: 1,
    leafId: '11111111-1111-4111-8111-111111111111',
    stablePaneId: '11111111-1111-4111-8111-111111111111',
    terminal,
    container: root,
    linkTooltip: document.createElement('div'),
    fitAddon: new FitAddon(),
    searchAddon: new SearchAddon(),
    serializeAddon: new SerializeAddon()
  }
  const manager = new PaneManager(root, { linkOpenHint: () => '' })
  const successorManager = new PaneManager(document.createElement('div'), {
    linkOpenHint: () => ''
  })
  const destroy = manager.destroy.bind(manager)
  vi.spyOn(manager, 'getPanes').mockReturnValue([pane])
  vi.spyOn(manager, 'getActivePane').mockReturnValue(pane)
  const terminalDispose = vi.spyOn(terminal, 'dispose')
  vi.spyOn(manager, 'destroy').mockImplementation(() => {
    events.push('emulator')
    terminal.dispose()
    destroy()
  })
  const successorDestroy = vi.spyOn(successorManager, 'destroy')
  const transport = (name: string): PtyTransport => ({
    connect: async () => name,
    attach: () => {},
    disconnect: () => {},
    sendInput: () => true,
    sendInputImmediate: () => true,
    resize: () => true,
    isConnected: () => true,
    getPtyId: () => name,
    getConnectionId: () => null,
    detach: () => {
      events.push(`${name}:detach`)
    },
    destroy: () => {
      events.push(`${name}:destroy`)
    }
  })
  const old = transport('A')
  const successor = transport('B')
  const refs: TerminalPaneLifecycleRefs = {
    systemPrefersDarkRef: { current: false },
    previousVisibleForReconcileRef: { current: null },
    linkProviderDisposablesRef: { current: new Map() },
    terminalHandleLinkDisposablesRef: { current: new Map() },
    linkifierClickPrimingDisposablesRef: { current: new Map() },
    linkPointerGesturesRef: { current: new Map() },
    fileLinkClickFallbackDisposablesRef: { current: new Map() },
    httpLinkClickFallbackDisposablesRef: { current: new Map() },
    selectionDisposablesRef: { current: new Map() },
    nativeCopyDisposablesRef: { current: new Map() },
    selectionCaptureTimersRef: { current: new Map() },
    osc52DisposablesRef: { current: new Map() },
    osc7DisposablesRef: { current: new Map() },
    mouseHideDisposablesRef: { current: new Map() },
    imeCompositionDisposablesRef: { current: new Map() },
    imeNativeTextForwarderDisposablesRef: { current: new Map() },
    queuedInitialCwdRef: { current: undefined },
    restoredViewportBlankingPanesRef: { current: new Set() },
    replayingPanesRef: { current: new Map() }
  }
  const deps: UseTerminalPaneLifecycleDeps = {
    tabId: 'tab',
    worktreeId: 'wt',
    isActive: true,
    isVisible: true,
    systemPrefersDark: false,
    settings: null,
    settingsRef: { current: null },
    requestOpenLinksInAppPreference: vi.fn(),
    requestTerminalLinkAction: vi.fn(),
    effectiveMacOptionAsAlt: 'false',
    effectiveMacOptionAsAltRef: { current: 'false' },
    initialLayoutRef: {
      current: {
        root: { type: 'leaf', leafId: pane.leafId },
        activeLeafId: pane.leafId,
        expandedLeafId: null
      }
    },
    managerRef: { current: manager },
    getTabWideAgentHintLeafId: () => null,
    containerRef: { current: root },
    expandedStyleSnapshotRef: { current: new Map() },
    paneFontSizesRef: { current: new Map([[1, 14]]) },
    paneTransportsRef: { current: new Map([[1, old]]) },
    paneCwdRef: { current: new Map([[1, { cwd: '/A', confirmed: true }]]) },
    paneMode2031Ref: { current: new Map([[1, true]]) },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map([[1, 'dark']]) },
    panePtyBindingsRef: { current: new Map() },
    replayingPanesRef: refs.replayingPanesRef,
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    onPtyRecoveryStateRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: () => false,
    isPtyShutdownPending: () => false,
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn(),
    markTerminalBell: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBindingForLeaf: vi.fn(),
    clearExitedPanePtyLayoutBindingForLeaf: vi.fn(),
    setTabPaneExpanded: vi.fn(),
    setTabCanExpandPane: vi.fn(),
    setExpandedPane: vi.fn(),
    syncExpandedLayout: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    showPaneTitle: vi.fn(),
    setPaneTitles: vi.fn(),
    paneTitlesRef: { current: { 1: 'A' } },
    setRenamingPaneId: vi.fn(),
    setPaneCount: vi.fn(),
    setPaneLayoutRevision: vi.fn()
  }
  let ended = false
  let reenter: () => void = () => {}
  let throwFirst = false
  const owner = installTerminalLinkPtyMouseSuppression(
    { element: root, clearSelection: () => terminal.clearSelection() },
    {
      candidate: () => 'link',
      eligible: () => true,
      canContinue: () => true
    }
  )
  const bytes: string[] = []
  const forward = (text: string): void => {
    if (!ended) {
      bytes.push(`A:${text}`)
    }
    events.push('owner-settle')
    reenter()
    if (throwFirst) {
      throw new Error('first input settlement')
    }
  }
  owner.bindSource({ isCurrent: () => !ended, user: forward, unclassified: forward })
  const emitter = new EventTarget()
  const dataListener = (): void => {
    owner.handlePtyInput('\x1b[<0;1;1M', forward, true)
  }
  emitter.addEventListener('input', dataListener)
  root.addEventListener('mousedown', () => emitter.dispatchEvent(new Event('input')))
  const binding = {
    dispose: vi.fn(() => {
      emitter.removeEventListener('input', dataListener)
      events.push('input-detach')
      owner.dispose()
    })
  }
  deps.panePtyBindingsRef.current.set(1, binding)
  const later = {
    dispose: vi.fn(() => {
      events.push('later-resource')
      if (throwFirst) {
        throw new Error('later resource failure')
      }
    })
  }
  const final = {
    dispose: vi.fn(() => {
      events.push('final-resource')
    })
  }
  refs.linkProviderDisposablesRef.current.set(1, later)
  refs.osc7DisposablesRef.current.set(1, final)
  const oldTimer = window.setTimeout(() => {
    events.push('old-timer-fired')
  }, 50)
  refs.selectionCaptureTimersRef.current.set(1, oldTimer)
  const successorDisposable = { dispose: vi.fn() }
  let newTimer: number | undefined
  const replace = (): void => {
    deps.paneTransportsRef.current.set(1, successor)
    deps.panePtyBindingsRef.current.set(1, successorDisposable)
    deps.managerRef.current = successorManager
    refs.linkProviderDisposablesRef.current.set(1, successorDisposable)
    newTimer = window.setTimeout(() => {
      events.push('successor-timer')
    }, 50)
    refs.selectionCaptureTimersRef.current.set(1, newTimer)
    deps.paneTitlesRef.current = { 1: 'B' }
    deps.paneCwdRef.current.set(1, { cwd: '/B', confirmed: true })
  }
  const deferredSplitHandoffs = new Map()
  cleanups.push(() => {
    owner.dispose()
    successorManager.destroy()
    root.remove()
    window.clearTimeout(oldTimer)
    if (newTimer !== undefined) {
      window.clearTimeout(newTimer)
    }
    if (terminalDispose.mock.calls.length === 0) {
      terminal.dispose()
    }
    destroy()
  })
  return {
    events,
    deps,
    refs,
    bytes,
    binding,
    later,
    final,
    successor,
    successorManager,
    successorDisposable,
    successorDestroy,
    start: () =>
      root.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true })),
    end: () => {
      ended = true
    },
    failAndReplace: () => {
      throwFirst = true
      reenter = replace
    },
    lateInput: () => emitter.dispatchEvent(new Event('input')),
    mount: () =>
      cleanupTerminalPaneMount({
        manager,
        deps,
        refs,
        deferredSplitHandoffs,
        expandedStyleSnapshots: deps.expandedStyleSnapshotRef.current,
        unregisterRuntimeTab: () => {
          events.push('unregister')
        },
        cancelResize: () => {
          events.push('resize-cancel')
        }
      }),
    close: () =>
      createTerminalPaneClosedHandler({ deps, refs, deferredSplitHandoffs })(1, {
        leafId: pane.leafId,
        reason: 'close'
      })
  }
}

it.each(['mount', 'close'] as const)(
  'actual %s cleanup attempts old resources and preserves a reentrant successor after throws',
  async (caller) => {
    const h = fixture()
    h.start()
    expect(h.bytes).toEqual([])
    h.failAndReplace()
    expect(() => h[caller]()).toThrow('first input settlement')
    expect(h.events.slice(0, 4)).toEqual([
      'input-detach',
      'owner-settle',
      'later-resource',
      'final-resource'
    ])
    expect(h.events).toContain(caller === 'mount' ? 'A:detach' : 'A:destroy')
    if (caller === 'mount') {
      expect(h.events).toContain('emulator')
    }
    expect(h.binding.dispose).toHaveBeenCalledOnce()
    expect(h.later.dispose).toHaveBeenCalledOnce()
    expect(h.final.dispose).toHaveBeenCalledOnce()
    expect(h.bytes).toEqual(['A:\x1b[<0;1;1M'])
    h.lateInput()
    expect(h.bytes).toHaveLength(1)
    expect(h.deps.paneTransportsRef.current.get(1)).toBe(h.successor)
    expect(h.deps.panePtyBindingsRef.current.get(1)).toBe(h.successorDisposable)
    expect(h.refs.linkProviderDisposablesRef.current.get(1)).toBe(h.successorDisposable)
    expect(h.deps.managerRef.current).toBe(h.successorManager)
    expect(h.deps.paneTitlesRef.current).toEqual({ 1: 'B' })
    expect(h.deps.paneCwdRef.current.get(1)?.cwd).toBe('/B')
    expect(state.clearTabLaunchAgent).not.toHaveBeenCalled()
    expect(h.deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
    expect(h.deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(h.deps.syncPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(h.deps.setTabPaneExpanded).not.toHaveBeenCalled()
    expect(h.successorDisposable.dispose).not.toHaveBeenCalled()
    expect(h.successorDestroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    expect(h.events).toContain('successor-timer')
    expect(h.events).not.toContain('old-timer-fired')
  }
)

it.each(['mount', 'close'] as const)(
  'actual %s cleanup refuses ended A and detaches its real old emitter',
  (caller) => {
    const h = fixture()
    h.start()
    h.end()
    h[caller]()
    h.lateInput()
    expect(h.bytes).toEqual([])
    expect(h.events[0]).toBe('input-detach')
    expect(h.events).toContain(caller === 'mount' ? 'A:detach' : 'A:destroy')
    expect(h.binding.dispose).toHaveBeenCalledOnce()
    expect(h.later.dispose).toHaveBeenCalledOnce()
    expect(h.final.dispose).toHaveBeenCalledOnce()
  }
)
