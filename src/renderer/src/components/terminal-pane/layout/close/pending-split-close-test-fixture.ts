import { afterEach, beforeEach, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { TerminalTabRetirementState } from '@/store/terminals/retirement/terminal-tab-retirement'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectResult, PtyTransport } from '../../pty-transport/pty-transport-types'
import type { TerminalPaneBindingController } from '../ownership/use-terminal-pane-layout-bindings'
import {
  installIpcPtyWindow,
  restorePtySpecWindow
} from '../../pty-transport/ipc/pty-transport-test-harness'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const store = vi.hoisted((): { current: AppState | null } => ({ current: null }))
vi.mock('../../../../store/index', () => ({ useAppStore: { getState: () => store.current } }))
vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useImperativeHandle: () => {},
  useRef: (current: unknown) => ({ current })
}))
vi.mock('../../../../runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('../../../terminal/terminal-close-copy-kind', () => ({ resolveLeafCloseCopyKind: vi.fn() }))
vi.mock('../../../terminal/running-terminal-close-guard', () => ({
  RUNNING_CLOSE_PROBE_TIMEOUT_MS: 100
}))
vi.mock('../../../terminal/pty-running-work-probe', () => ({ probePtyRunningWork: vi.fn() }))
vi.mock('../detach/terminal-pane-tab-detach', () => ({
  detachTerminalPaneToTab: vi.fn()
}))
vi.mock('./terminal-pane-close-identity', () => ({
  resolveTabTitleAfterPaneClose: vi.fn(),
  shouldClearLaunchAgentForClosedPane: () => false
}))
vi.mock('../../pty-transport/renderer-active-pty', () => ({
  reportActiveRendererPtyForPane: vi.fn()
}))
vi.mock('../split/deferred-split-pane-handoff', () => ({
  clearDeferredSplitPaneHandoff: vi.fn(),
  discardDeferredSplitPaneHandoffForKey: vi.fn()
}))
vi.mock('../expand/expanded-pane-layout', () => ({ useExpandCollapseActions: () => ({}) }))

const originalWindow = globalThis.window
beforeEach(() => {
  vi.resetModules()
  installIpcPtyWindow(originalWindow, {})
})
afterEach(() => {
  restorePtySpecWindow(originalWindow)
  vi.restoreAllMocks()
})

export function makeCloseTestTab(
  id: string,
  ptyId: string | null,
  worktreeId = 'workspace'
): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

export async function preparePendingSplitClose(
  requestedPtyId = 'pty-restored',
  worktreeId = 'workspace'
) {
  const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
  const { useTerminalPaneLayoutBindings } =
    await import('../ownership/use-terminal-pane-layout-bindings')
  const { useTerminalPaneCloseActions } = await import('./use-terminal-pane-close-actions')
  const { createTerminalPaneClosedHandler } =
    await import('../../mounting/terminal-pane-closed-handler')
  const { useTerminalPaneLifecycleRefs } =
    await import('../../mounting/use-terminal-pane-lifecycle-refs')
  const tabId = 'tab-parent'
  const leafId = '11111111-1111-4111-8111-111111111111'
  const siblingLeafId = '22222222-2222-4222-8222-222222222222'
  const state: TerminalTabRetirementState = {
    worktreesByRepo: { repo: [{ id: worktreeId, repoId: 'repo', hostId: 'local' }] },
    tabsByWorktree: { [worktreeId]: [makeCloseTestTab(tabId, requestedPtyId, worktreeId)] },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: { [tabId]: [requestedPtyId] },
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    terminalLayoutsByTabId: {
      [tabId]: {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', leafId },
          second: { type: 'leaf', leafId: siblingLeafId }
        },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: requestedPtyId, [siblingLeafId]: 'pty-sibling' }
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real close paths read only this retirement state and the supplied actions.
  store.current = Object.assign(state, {
    setCacheTimerStartedAt: vi.fn(),
    dropAgentStatus: vi.fn(),
    retireAgentPaneAuthority: vi.fn(),
    suppressPtyExit: vi.fn()
  }) as unknown as AppState
  // Only main’s layout commands may close panes in this build; the transport refuses uncommanded calls.
  const { layoutApplyTestTransport: main } =
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  const runtimeCall = async ({ params }: { params?: unknown }) => ({
    ok: true,
    result: await main.call(params)
  })
  Object.assign(window.api, { runtime: { ...window.api.runtime, call: vi.fn(runtimeCall) } })
  const spawn = Promise.withResolvers<PtyConnectResult>()
  vi.mocked(window.api.pty.spawn).mockReturnValueOnce(spawn.promise)
  const transport = createIpcPtyTransport({})
  const connecting = transport.connect({ url: '', sessionId: requestedPtyId, callbacks: {} })
  let onClosed: ReturnType<typeof createTerminalPaneClosedHandler> = () => {}
  let panes = [
    { id: 1, leafId },
    { id: 2, leafId: siblingLeafId }
  ]
  const managerFixture = {
    getPanes: () => panes,
    getLeafId: (id: number) => panes.find((pane) => pane.id === id)?.leafId ?? null,
    getActivePane: () => null,
    closePane(id: number) {
      panes = panes.filter((pane) => pane.id !== id)
      onClosed(id, { leafId, reason: 'close' })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These real close methods use only the four manager operations above; no DOM is mounted.
  const manager = managerFixture as unknown as PaneManager
  const transports = new Map<number, PtyTransport>([[1, transport]])
  const partial: Partial<TerminalPaneBindingController> = {
    tabId,
    worktreeId,
    managerRef: { current: manager },
    paneTransportsRef: { current: transports },
    panePtyBindingsRef: { current: new Map() },
    paneMode2031Ref: { current: new Map() },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    paneTitlesRef: { current: {} },
    expandedPaneIdRef: { current: null },
    expandedStyleSnapshotRef: { current: new Map() },
    containerRef: { current: null },
    pendingPaneSizeRefreshFrameIdsRef: { current: [] },
    clearSessionRestoredBannerForPane: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    setPendingCloseConfirmation: vi.fn(),
    setTerminalErrorsByPaneId: vi.fn(),
    updateSettings: vi.fn(),
    setExpandedPaneId: vi.fn(),
    setTabPaneExpanded: vi.fn(),
    onCloseTab: vi.fn(),
    clearTabPtyId: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    setPaneTitles: vi.fn(),
    setRenamingPaneId: vi.fn(),
    setPaneCount: vi.fn(),
    updateTabTitle: vi.fn(),
    setTabLayout: (_tabId, layout) => {
      if (layout) {
        state.terminalLayoutsByTabId[tabId] = layout
      } else {
        delete state.terminalLayoutsByTabId[tabId]
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every controller field read by the three exercised hooks is provided above or assigned from the real binding hook below.
  const controller = partial as TerminalPaneBindingController
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- React registration is mocked; exercise the real binding callbacks without mounting UI.
  Object.assign(controller, useTerminalPaneLayoutBindings(controller))
  const closeContext = {
    deps: {
      ...controller,
      effectiveMacOptionAsAltRef: { current: 'false' as const },
      consumeSuppressedPtyExit: () => false,
      isPtyShutdownPending: () => false,
      onShowSessionRestoredBanner: vi.fn()
    },
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- The mocked useRef allocates the real per-pane ownership registries.
    refs: useTerminalPaneLifecycleRefs(),
    deferredSplitHandoffs: new Map()
  }
  onClosed = createTerminalPaneClosedHandler(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real close handler reads only deps, refs, and deferredSplitHandoffs from its broader mount context.
    closeContext as unknown as Parameters<typeof createTerminalPaneClosedHandler>[0]
  )
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- React registration is mocked; exercise the real close callbacks without mounting UI.
  const actions = useTerminalPaneCloseActions(controller)
  return {
    /** Lets main answer the window's closes (a layout-owner build); nothing to wait for otherwise. */
    mainAnswered: () => main.settle(),
    sentPaneCloses: () => main.sentOfType('closePane'),
    transport,
    transports,
    connecting,
    spawn,
    controller,
    actions,
    state,
    tabId,
    leafId,
    siblingLeafId
  }
}
