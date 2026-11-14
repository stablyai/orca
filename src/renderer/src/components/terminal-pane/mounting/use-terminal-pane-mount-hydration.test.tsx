// @vitest-environment happy-dom
import type * as ScrollbackReadsModule from '@/runtime/hosted-terminals/hydration/host-terminal-scrollback-reads'
import { StrictMode, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalPaneProps } from '../controller/terminal-pane-types'
import {
  type TerminalPaneHydrationFixtureState,
  FIRST_LEAF,
  SECOND_LEAF,
  FIRST_REF,
  SECOND_REF,
  NEW_REF,
  HeadlessMountManager,
  mountDeps,
  parsedRows
} from './terminal-pane-hydration-test-fixture'

const state = vi.hoisted((): TerminalPaneHydrationFixtureState => ({
  deps: null,
  reads: vi.fn<(ref: string) => Promise<string | null>>(),
  store: {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    localOnlyScrollbackByTabId: {},
    repos: [],
    allWorktrees: () => [],
    consumeTabInitialCwd: () => null,
    setTabLayout: vi.fn(),
    setTabLocalOnlyScrollback: vi.fn(),
    consumeSuppressedPtyExit: () => false,
    isPtyShutdownPending: () => false
  }
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state.store } }))
vi.mock('@/lib/pane-manager/pane-manager', async () => ({
  PaneManager: (await import('./terminal-pane-hydration-test-fixture')).HeadlessMountManager
}))
vi.mock('./terminal-pane-manager-options', () => ({
  createTerminalPaneManagerOptions: () => ({})
}))
vi.mock('./terminal-pane-mount-events', () => ({ installTerminalPaneMountEvents: () => () => {} }))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: () => {}
}))
vi.mock('@/app-shell/startup/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))
vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/browser/workspace/workspace-browser-tab-open', () => ({}))
vi.mock('../host-state/terminal-pane-wsl-distro', () => ({ resolvePaneWslDistro: () => null }))
vi.mock('../links/terminal-link-open-hints', () => ({
  getTerminalFileOpenHint: () => '',
  getTerminalUrlOpenHint: () => '',
  terminalUrlOpenHintOptionsFor: () => ({})
}))
vi.mock('../appearance/terminal-appearance', () => ({ applyTerminalAppearance: () => {} }))
vi.mock('@/store/appearance/theme-background', () => ({ useThemeBackgroundStore: () => false }))
vi.mock('@/store/plugins/appearance/plugin-fonts', () => ({ usePluginFontReady: () => false }))
vi.mock('../parking/output-watchers/terminal-parked-tab-watchers', () => ({}))
vi.mock('../parking/output-watchers/terminal-parked-watcher-registry', () => ({
  isTerminalTabParked: () => true,
  captureParkedTerminalPaneCandidates: () => {}
}))
vi.mock('@/web/preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => null
}))
vi.mock(
  '@/runtime/hosted-terminals/hydration/host-terminal-scrollback-reads',
  async (importOriginal) => {
    const original = await importOriginal<typeof ScrollbackReadsModule>()
    return {
      ...original,
      defaultDeps: {
        ...original.defaultDeps,
        readLocalSnapshot: (ref: string) => state.reads(ref),
        resolveEnvironmentId: () => null
      }
    }
  }
)
// Keep the actual pane boundary and production mount pipeline; isolate unrelated controller/UI services.
vi.mock('../controller/use-terminal-pane-controller', async () => {
  const { useTerminalPaneLifecycleStage } = await import('./use-terminal-pane-lifecycle-stage')
  const { useTerminalPaneLayoutPersistence } =
    await import('../layout/persistence/use-terminal-pane-layout-persistence')
  return {
    useTerminalPaneController: (props: TerminalPaneProps) => {
      const deps = state.deps!
      const lifecycleController = {
        ...deps,
        ...props,
        isRendererVisible: props.isVisible ?? true,
        expandedPaneIdRef: useRef(null),
        removedTitleLeafIdsRef: useRef(new Set<string>()),
        remotePaneLayoutPusherRef: useRef(null),
        chatLeafId: null,
        isChatViewMode: false,
        paneCount: 0,
        paneTitles: {},
        setTabLayout: state.store.setTabLayout,
        macOptionAsAltRef: deps.effectiveMacOptionAsAltRef,
        getTabWideAgentHintLeafIdRef: { current: deps.getTabWideAgentHintLeafId },
        showRestoredSessionBanner: deps.onShowSessionRestoredBanner
      }
      const controller =
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture provides the lifecycle/persistence fields; unrelated controller UI is excluded.
        lifecycleController as unknown as Parameters<typeof useTerminalPaneLifecycleStage>[0]
      const persistence = useTerminalPaneLayoutPersistence(controller)
      const mount = useTerminalPaneLifecycleStage({ ...controller, ...persistence })
      return {
        ...mount,
        clearFirst: () => {
          const pane = deps.managerRef.current?.getPanes()[0]
          if (pane) {
            persistence.clearPaneScrollback(pane)
          }
        }
      }
    }
  }
})
vi.mock('../controller/TerminalPaneSurface', () => ({
  TerminalPaneSurface: ({ controller }: { controller: { clearFirst: () => void } }) => (
    <button onClick={controller.clearFirst}>Clear history</button>
  )
}))
import TerminalPane from '../TerminalPane'
import { resetHostTerminalScrollbackHydrationForTests } from '@/runtime/hosted-terminals/hydration/host-terminal-scrollback-hydration'

function terminalTab(id: string, worktreeId = 'wt-1'): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const props = {
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  cwd: '/first',
  isActive: false,
  isVisible: true,
  onPtyExit: vi.fn(),
  onCloseTab: vi.fn()
}
function savedLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: FIRST_LEAF },
      second: { type: 'leaf', leafId: SECOND_LEAF }
    },
    activeLeafId: FIRST_LEAF,
    expandedLeafId: null,
    scrollbackRefsByLeafId: { [FIRST_LEAF]: FIRST_REF, [SECOND_LEAF]: SECOND_REF }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  state.deps = mountDeps()
  state.store.tabsByWorktree = { 'wt-1': [terminalTab('tab-1')] }
  state.store.terminalLayoutsByTabId = { 'tab-1': savedLayout() }
  state.store.localOnlyScrollbackByTabId = {}
  state.store.setTabLayout.mockReset()
  state.store.setTabLocalOnlyScrollback.mockReset()
  state.reads.mockReset()
  HeadlessMountManager.instances = []
  resetHostTerminalScrollbackHydrationForTests()
})
afterEach(() => cleanup())

describe('manager-owned saved history', () => {
  it('retires a pending cwd and StrictMode setup, then restores current park bytes and changed refs', async () => {
    const old = deferred<string>()
    const newer = deferred<string>()
    state.reads.mockImplementation((ref) => (ref === NEW_REF ? newer.promise : old.promise))
    const view = render(
      <StrictMode>
        <TerminalPane {...props} />
      </StrictMode>
    )
    await waitFor(() => expect(state.reads).toHaveBeenCalledWith(FIRST_REF))
    view.rerender(
      <StrictMode>
        <TerminalPane {...props} cwd="/second" />
      </StrictMode>
    )
    state.store.terminalLayoutsByTabId['tab-1'] = {
      ...savedLayout(),
      scrollbackRefsByLeafId: { [FIRST_LEAF]: FIRST_REF, [SECOND_LEAF]: NEW_REF }
    }
    state.store.localOnlyScrollbackByTabId['tab-1'] = { [FIRST_LEAF]: 'newer parked history' }
    await act(async () => {
      old.resolve('obsolete disk bytes')
    })
    await waitFor(() => expect(state.reads).toHaveBeenCalledWith(NEW_REF))
    expect(HeadlessMountManager.instances).toHaveLength(0)
    await act(async () => {
      newer.resolve('current second pane')
    })
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
    expect(await parsedRows(HeadlessMountManager.instances[0])).toEqual([
      'newer parked history\n\n\n\n\n',
      'current second pane\n\n\n\n\n'
    ])
  })

  it('keeps cleared inline history gone on cwd replacement while its saved-ref sibling restores', async () => {
    state.store.terminalLayoutsByTabId['tab-1'] = {
      ...savedLayout(),
      buffersByLeafId: { [FIRST_LEAF]: 'cleared inline history must not return\r\ncurrent prompt' },
      scrollbackRefsByLeafId: { [SECOND_LEAF]: SECOND_REF }
    }
    state.store.setTabLayout.mockImplementation((tabId: string, layout: TerminalLayoutSnapshot) => {
      state.store.terminalLayoutsByTabId[tabId] = layout
    })
    state.reads.mockResolvedValue('saved sibling history')
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
    expect(await parsedRows(HeadlessMountManager.instances[0])).toEqual([
      'cleared inline history must not return\ncurrent prompt\n\n\n\n',
      'saved sibling history\n\n\n\n\n'
    ])
    fireEvent.click(screen.getByText('Clear history'))
    view.rerender(<TerminalPane {...props} cwd="/after-clear" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
      '\n\n\n\n\n',
      'saved sibling history\n\n\n\n\n'
    ])
  })
})
