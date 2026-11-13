// @vitest-environment happy-dom
import type * as ScrollbackReadsModule from '@/runtime/hosted-terminals/hydration/host-terminal-scrollback-reads'
import { StrictMode, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneProps } from '../controller/terminal-pane-types'
import type { PtyConnectionDeps } from '../pty-connection/pty-connection-deps'
import {
  type TerminalPaneHydrationFixtureState,
  FIRST_LEAF,
  SECOND_LEAF,
  FIRST_REF,
  SECOND_REF,
  NEW_REF,
  HeadlessMountManager,
  mountDeps,
  parsedRows,
  registerRuntimeClear
} from './terminal-pane-hydration-test-fixture'

const state = vi.hoisted((): TerminalPaneHydrationFixtureState => ({
  deps: null,
  reads: vi.fn<(ref: string) => Promise<string | null>>(),
  parked: true,
  consumeIssue: vi.fn(),
  depsByTab: {},
  renders: new Map<string, number>(),
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
  createTerminalPaneManagerOptions: (context: { ptyDeps: PtyConnectionDeps }) => ({
    getStartup: () => context.ptyDeps.startup,
    ptyDeps: context.ptyDeps
  })
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
  isTerminalTabParked: () => state.parked,
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
      const [draft, setDraft] = useState('')
      const deps = state.depsByTab[props.tabId] ?? state.deps!
      const [issueCommandSplit] = useState(() => deps.issueCommandSplit)
      const lifecycleController = {
        ...deps,
        ...props,
        issueCommandSplit,
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
        showRestoredSessionBanner: deps.onShowSessionRestoredBanner,
        consumeTabIssueCommandSplit: state.consumeIssue
      }
      const controller =
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture provides the lifecycle/persistence fields; unrelated controller UI is excluded.
        lifecycleController as unknown as Parameters<typeof useTerminalPaneLifecycleStage>[0]
      const persistence = useTerminalPaneLayoutPersistence(controller)
      const mount = useTerminalPaneLifecycleStage({ ...controller, ...persistence })
      return {
        ...mount,
        draft,
        setDraft,
        tabId: props.tabId,
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
  TerminalPaneSurface: ({
    controller
  }: {
    controller: {
      tabId: string
      draft: string
      setDraft: (value: string) => void
      clearFirst: () => void
    }
  }) => {
    state.renders.set(controller.tabId, (state.renders.get(controller.tabId) ?? 0) + 1)
    return (
      <>
        <button onClick={controller.clearFirst}>Clear history</button>
        <input
          aria-label="Search draft"
          value={controller.draft}
          onChange={(event) => controller.setDraft(event.target.value)}
        />
      </>
    )
  }
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
    scrollbackRefsByLeafId: { [FIRST_LEAF]: FIRST_REF, [SECOND_LEAF]: SECOND_REF },
    ptyIdsByLeafId: { [SECOND_LEAF]: 'remote:live-tui' }
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
  state.depsByTab = {}
  state.renders.clear()
  state.consumeIssue.mockReset()
  state.store.tabsByWorktree = { 'wt-1': [terminalTab('tab-1')] }
  state.store.terminalLayoutsByTabId = { 'tab-1': savedLayout() }
  state.store.localOnlyScrollbackByTabId = {}
  state.store.setTabLayout.mockReset()
  state.store.setTabLocalOnlyScrollback.mockReset()
  state.reads
    .mockReset()
    .mockImplementation(async (ref) =>
      ref === FIRST_REF ? 'saved shell history' : 'launch line\r\n\x1b[?1049h\x1b[Hsaved live TUI'
    )
  HeadlessMountManager.instances = []
  resetHostTerminalScrollbackHydrationForTests()
})
afterEach(() => cleanup())

describe('manager-owned saved history', () => {
  it('replays both saved panes after a cwd replacement while preserving the open draft', async () => {
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
    expect(await parsedRows(HeadlessMountManager.instances[0])).toEqual([
      'saved shell history\n\n\n\n\n',
      'saved live TUI\n\n\n\n\n'
    ])
    fireEvent.change(screen.getByLabelText('Search draft'), { target: { value: 'unsaved query' } })
    expect(state.deps!.initialLayoutRef.current.buffersByLeafId).toBeUndefined()
    await act(async () => {
      await Promise.resolve()
    })
    state.reads.mockImplementation(async (ref) =>
      ref === FIRST_REF
        ? 'new saved shell history'
        : 'launch line\r\n\x1b[?1049h\x1b[Hnew saved live TUI'
    )
    view.rerender(<TerminalPane {...props} cwd="/second" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
      'new saved shell history\n\n\n\n\n',
      'new saved live TUI\n\n\n\n\n'
    ])
    expect(HeadlessMountManager.instances[0].destroyed).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Search draft').value).toBe('unsaved query')
    expect(state.store.setTabLocalOnlyScrollback).not.toHaveBeenCalled()
  })

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
        <TerminalPane {...props} cwd="/second" isVisible={false} />
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
    expect(state.deps!.isVisibleRef.current).toBe(false)
    expect(HeadlessMountManager.instances[0].gpu).toBe('auto')
    view.unmount()
    expect(HeadlessMountManager.instances[0].destroyed).toBe(true)
  })
  it('replays released inline history on a cwd-only replacement without a saved ref', async () => {
    const inline = savedLayout()
    delete inline.scrollbackRefsByLeafId
    inline.buffersByLeafId = {
      [FIRST_LEAF]: 'remote inline shell history',
      [SECOND_LEAF]: 'remote inline TUI frame'
    }
    state.store.terminalLayoutsByTabId['tab-1'] = inline
    state.store.setTabLayout.mockImplementation((tabId: string, layout: TerminalLayoutSnapshot) => {
      state.store.terminalLayoutsByTabId[tabId] = layout
    })
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
    expect(await parsedRows(HeadlessMountManager.instances[0])).toEqual([
      'remote inline shell history\n\n\n\n\n',
      'remote inline TUI frame\n\n\n\n\n'
    ])
    expect(state.store.terminalLayoutsByTabId['tab-1'].buffersByLeafId).toBeUndefined()
    state.store.setTabLayout.mockClear()
    view.rerender(<TerminalPane {...props} cwd="/second" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
      'remote inline shell history\n\n\n\n\n',
      'remote inline TUI frame\n\n\n\n\n'
    ])
    for (const [, layout] of state.store.setTabLayout.mock.calls) {
      expect(layout.buffersByLeafId).toBeUndefined()
    }
    view.rerender(<TerminalPane {...props} cwd="/third" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(3))
    expect(await parsedRows(HeadlessMountManager.instances[2])).toEqual([
      'remote inline shell history\n\n\n\n\n',
      'remote inline TUI frame\n\n\n\n\n'
    ])
    for (const [, layout] of state.store.setTabLayout.mock.calls) {
      expect(layout.buffersByLeafId).toBeUndefined()
    }
  })

  it('retains only current no-ref winners through mixed replay, empty bytes and leaf removal', async () => {
    const initial = savedLayout()
    delete initial.scrollbackRefsByLeafId
    initial.buffersByLeafId = {
      [FIRST_LEAF]: 'old first history',
      [SECOND_LEAF]: 'old second history'
    }
    state.store.terminalLayoutsByTabId['tab-1'] = initial
    state.store.setTabLayout.mockImplementation((tabId: string, layout: TerminalLayoutSnapshot) => {
      state.store.terminalLayoutsByTabId[tabId] = layout
    })
    state.store.setTabLocalOnlyScrollback.mockImplementation(
      (tabId: string, buffers: Record<string, string> | null) => {
        if (buffers) {
          state.store.localOnlyScrollbackByTabId[tabId] = buffers
        } else {
          delete state.store.localOnlyScrollbackByTabId[tabId]
        }
      }
    )
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
    state.store.terminalLayoutsByTabId['tab-1'] = {
      ...savedLayout(),
      scrollbackRefsByLeafId: { [SECOND_LEAF]: SECOND_REF },
      buffersByLeafId: { [FIRST_LEAF]: 'new inline winner' }
    }
    state.store.localOnlyScrollbackByTabId['tab-1'] = { [SECOND_LEAF]: 'new parked ref history' }
    view.rerender(<TerminalPane {...props} cwd="/mixed" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
      'new inline winner\n\n\n\n\n',
      'new parked ref history\n\n\n\n\n'
    ])
    expect(state.store.localOnlyScrollbackByTabId['tab-1']).toBeUndefined()
    state.reads.mockResolvedValue('ref-backed replacement')
    view.rerender(<TerminalPane {...props} cwd="/mixed-again" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(3))
    expect(await parsedRows(HeadlessMountManager.instances[2])).toEqual([
      'new inline winner\n\n\n\n\n',
      'ref-backed replacement\n\n\n\n\n'
    ])
    state.store.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: FIRST_LEAF },
      activeLeafId: FIRST_LEAF,
      expandedLeafId: null,
      buffersByLeafId: { [FIRST_LEAF]: '' },
      titlesByLeafId: { [FIRST_LEAF]: 'current title' }
    }
    view.rerender(<TerminalPane {...props} cwd="/removed" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(4))
    expect(await parsedRows(HeadlessMountManager.instances[3])).toEqual(['\n\n\n\n\n'])
    expect(HeadlessMountManager.instances[3].getPanes().map((pane) => pane.leafId)).toEqual([
      FIRST_LEAF
    ])
    const reintroduced = savedLayout()
    delete reintroduced.scrollbackRefsByLeafId
    state.store.terminalLayoutsByTabId['tab-1'] = reintroduced
    view.rerender(<TerminalPane {...props} cwd="/reintroduced" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(5))
    expect(await parsedRows(HeadlessMountManager.instances[4])).toEqual([
      '\n\n\n\n\n',
      '\n\n\n\n\n'
    ])
  })

  it('drops inline fallback across committed owner changes even if the intervening read is pending', async () => {
    const inline = savedLayout()
    delete inline.scrollbackRefsByLeafId
    inline.buffersByLeafId = { [FIRST_LEAF]: 'owner A history' }
    state.store.terminalLayoutsByTabId['tab-1'] = inline
    state.store.setTabLayout.mockImplementation((tabId: string, layout: TerminalLayoutSnapshot) => {
      state.store.terminalLayoutsByTabId[tabId] = layout
    })
    state.store.tabsByWorktree['wt-2'] = [terminalTab('tab-2', 'wt-2')]
    state.store.terminalLayoutsByTabId['tab-2'] = savedLayout()
    const pending = deferred<string>()
    state.reads.mockReturnValue(pending.promise)
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
    view.rerender(<TerminalPane {...props} tabId="tab-2" worktreeId="wt-2" />)
    await waitFor(() => expect(state.reads).toHaveBeenCalledWith(FIRST_REF))
    view.rerender(<TerminalPane {...props} cwd="/returned" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
      '\n\n\n\n\n',
      '\n\n\n\n\n'
    ])
    await act(async () => pending.resolve('retired owner B history'))
    expect(HeadlessMountManager.instances).toHaveLength(2)
  })

  it('keeps cleared inline history gone across cwd replacements while its saved-ref sibling restores', async () => {
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
    expect(state.deps!.clearedScrollbackLeafIdsRef!.current.size).toBe(0)
    expect(state.store.terminalLayoutsByTabId['tab-1'].scrollbackRefsByLeafId).toEqual({
      [SECOND_LEAF]: SECOND_REF
    })
    view.rerender(<TerminalPane {...props} cwd="/after-clear" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
      '\n\n\n\n\n',
      'saved sibling history\n\n\n\n\n'
    ])
    view.rerender(<TerminalPane {...props} cwd="/after-clear-again" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(3))
    expect(await parsedRows(HeadlessMountManager.instances[2])).toEqual([
      '\n\n\n\n\n',
      'saved sibling history\n\n\n\n\n'
    ])
  })

  it('applies a runtime clear to the current replay owner before another cwd replacement', async () => {
    state.store.terminalLayoutsByTabId['tab-1'] = {
      ...savedLayout(),
      buffersByLeafId: { [FIRST_LEAF]: 'runtime-cleared history\r\ncurrent prompt' },
      scrollbackRefsByLeafId: { [SECOND_LEAF]: SECOND_REF },
      ptyIdsByLeafId: { [FIRST_LEAF]: 'pty-runtime-clear' }
    }
    state.store.setTabLayout.mockImplementation((tabId: string, layout: TerminalLayoutSnapshot) => {
      state.store.terminalLayoutsByTabId[tabId] = layout
    })
    state.reads.mockResolvedValue('saved sibling history')
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
    view.rerender(<TerminalPane {...props} cwd="/before-runtime-clear" />)
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
      'runtime-cleared history\ncurrent prompt\n\n\n\n',
      'saved sibling history\n\n\n\n\n'
    ])
    const registration = registerRuntimeClear(
      HeadlessMountManager.instances[1],
      'pty-runtime-clear'
    )
    try {
      registration.clear()
      view.rerender(<TerminalPane {...props} cwd="/after-runtime-clear" />)
      await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(3))
      expect(await parsedRows(HeadlessMountManager.instances[2])).toEqual([
        '\n\n\n\n\n',
        'saved sibling history\n\n\n\n\n'
      ])
    } finally {
      registration.dispose()
    }
  })

  it('does not repeat a dispatched issue command when persistence replaces its surface before readiness', async () => {
    const pending = deferred<string>()
    state.reads.mockReturnValue(pending.promise)
    state.deps!.issueCommandSplit = { command: 'issue runner', env: { ISSUE: '42' } }
    state.consumeIssue.mockImplementation(() => {
      state.deps!.issueCommandSplit = null
    })
    function ReplacedPane() {
      const [generation, setGeneration] = useState(0)
      state.store.setTabLayout.mockImplementationOnce((tabId, layout) => {
        state.store.terminalLayoutsByTabId[tabId] = layout
        setGeneration(1)
      })
      return <TerminalPane key={generation} {...props} />
    }
    render(<ReplacedPane />)
    await waitFor(() => expect(state.reads).toHaveBeenCalledWith(FIRST_REF))
    await act(async () => pending.resolve('saved history'))
    await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
    const commands = HeadlessMountManager.instances.flatMap((manager) =>
      manager.splitStartups.filter(Boolean)
    )
    expect(commands).toEqual([{ command: 'issue runner', env: { ISSUE: '42' } }])
    expect(HeadlessMountManager.instances[0].destroyed).toBe(true)
  })

  it('retains a queued split across a retired mount until its successor dispatches the startup', async () => {
    const pending = deferred<string>()
    state.reads.mockReturnValue(pending.promise)
    state.deps!.issueCommandSplit = { command: 'issue runner', env: { ISSUE: '42' } }
    let queued: UseTerminalPaneLifecycleDeps['issueCommandSplit'] = state.deps!.issueCommandSplit
    state.consumeIssue.mockImplementation(() => {
      expect(HeadlessMountManager.instances[0].splitStartups).toEqual([
        undefined,
        { command: 'issue runner', env: { ISSUE: '42' } }
      ])
      queued = null
    })
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => expect(state.reads).toHaveBeenCalledWith(FIRST_REF))
    view.rerender(<TerminalPane {...props} cwd="/successor" />)
    expect(queued).toEqual({ command: 'issue runner', env: { ISSUE: '42' } })
    expect(state.consumeIssue).not.toHaveBeenCalled()
    expect(HeadlessMountManager.instances).toHaveLength(0)
    await act(async () => pending.resolve('saved history'))
    await waitFor(() => expect(queued).toBeNull())
    expect(HeadlessMountManager.instances).toHaveLength(1)
    expect(await parsedRows(HeadlessMountManager.instances[0])).toEqual([
      'saved history\n\n\n\n\n',
      'saved history\n\n\n\n\n',
      '\n\n\n\n\n'
    ])
  })
})

it('keeps readiness local to one pane and releases retired reads before a later mount', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  state.depsByTab['tab-2'] = mountDeps()
  state.store.tabsByWorktree['wt-1'] = [terminalTab('tab-1'), terminalTab('tab-2')]
  state.store.terminalLayoutsByTabId['tab-2'] = {
    ...savedLayout(),
    scrollbackRefsByLeafId: { [FIRST_LEAF]: NEW_REF, [SECOND_LEAF]: NEW_REF }
  }
  state.reads.mockImplementation((ref) => (ref === NEW_REF ? second.promise : first.promise))
  const view = render(
    <>
      <TerminalPane {...props} />
      <TerminalPane {...props} tabId="tab-2" />
    </>
  )
  await waitFor(() => expect(state.reads).toHaveBeenCalledTimes(2))
  const siblingRenders = state.renders.get('tab-2')
  await act(async () => {
    first.resolve('first pane history')
  })
  await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(1))
  expect(state.renders.get('tab-2')).toBe(siblingRenders)
  view.unmount()
  await act(async () => {
    second.resolve('retired read history')
  })
  state.reads.mockResolvedValue('fresh retry history')
  const retry = render(<TerminalPane {...props} tabId="tab-2" />)
  await waitFor(() => expect(HeadlessMountManager.instances).toHaveLength(2))
  expect(await parsedRows(HeadlessMountManager.instances[1])).toEqual([
    'fresh retry history\n\n\n\n\n',
    'fresh retry history\n\n\n\n\n'
  ])
  retry.unmount()
})

// One bucket index visit per tab is sufficient to prove current ownership for every mount.
// Ten times as many owners must not multiply that work by every owner's validity checks.
it('indexes a shared tab bucket once through the production mount validity path at N and 10N', async () => {
  const { useTerminalPaneMountLifecycle } = await import('./use-terminal-pane-mount-lifecycle')
  const { useTerminalPaneLifecycleRefs } = await import('./use-terminal-pane-lifecycle-refs')
  for (const count of [300, 3_000]) {
    let entryVisits = 0
    const base = mountDeps()
    base.containerRef.current = null
    const tabs = Array.from({ length: count }, (_, index) => ({
      ...terminalTab(`scale-${index}`),
      get id() {
        entryVisits++
        return `scale-${index}`
      },
      ptyId: null
    }))
    state.store.tabsByWorktree = { 'wt-1': tabs }
    state.store.terminalLayoutsByTabId = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`scale-${index}`, savedLayout()])
    )
    state.reads.mockReset().mockResolvedValue(null)
    function PendingMount({ tabId }: { tabId: string }) {
      useTerminalPaneMountLifecycle({ ...base, tabId }, useTerminalPaneLifecycleRefs())
      return null
    }
    const view = render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <PendingMount key={index} tabId={`scale-${index}`} />
        ))}
      </>
    )
    await waitFor(() => expect(state.reads).toHaveBeenCalledTimes(count * 2), { timeout: 10_000 })
    expect(entryVisits).toBeLessThanOrEqual(count)
    expect(HeadlessMountManager.instances).toHaveLength(0)
    view.unmount()
  }
})
