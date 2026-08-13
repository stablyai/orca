// @vitest-environment happy-dom

// Why: unlike the focus test (which neuters useMemo and the store to call the
// hook as a plain function), these tests need REAL React rendering and a REAL
// zustand store — they pin subscription and referential-stability behavior
// (STA-3328: a global layout subscription + per-render commands literal made
// every PTY layout write reconcile every mounted tab strip).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const useAppStore = create(() => ({}) as never)
  return { useAppStore }
})

vi.mock('../../store/selectors', () => ({
  useAllWorktrees: () => [{ id: 'wt-1', path: '/worktree' }]
}))

vi.mock('../../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  toHostSessionTabId: (tabId: string) => tabId
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))

vi.mock('../../lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
}))

vi.mock('../../lib/ipc-error', () => ({
  extractIpcErrorMessage: (_error: unknown, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

import { useAppStore } from '../../store'
import { useTabGroupWorkspaceModel } from './useTabGroupWorkspaceModel'

function buildState(): Record<string, unknown> {
  const terminalTab = {
    id: 'terminal-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    defaultTitle: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const unifiedTab = {
    id: 'unified-terminal-1',
    entityId: terminalTab.id,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    activeWorktreeId: 'wt-1',
    browserTabsByWorktree: {},
    expandedPaneByTabId: {},
    groupsByWorktree: {
      'wt-1': [
        { id: 'group-1', worktreeId: 'wt-1', activeTabId: unifiedTab.id, tabOrder: [unifiedTab.id] }
      ]
    },
    openFiles: [],
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab] },
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { 'wt-1': [unifiedTab] },
    activateTab: vi.fn(),
    closeBrowserTab: vi.fn(),
    closeEmptyGroup: vi.fn(),
    closeFile: vi.fn(),
    closeTab: vi.fn(),
    closeUnifiedTab: vi.fn(),
    createBrowserTab: vi.fn(),
    createEmptySplitGroup: vi.fn(),
    createTab: vi.fn(),
    dropUnifiedTab: vi.fn(),
    focusGroup: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    openFile: vi.fn(),
    openNewBrowserTabInActiveWorkspace: vi.fn(),
    openNewMarkdownInActiveWorkspace: vi.fn(),
    openNewTerminalTabInActiveWorkspace: vi.fn(),
    pinFile: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    recordFeatureInteraction: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveWorktree: vi.fn(),
    setTabColor: vi.fn(),
    setTabCustomTitle: vi.fn()
  }
}

const probe = {
  renders: 0,
  model: null as ReturnType<typeof useTabGroupWorkspaceModel> | null
}

function Probe(): null {
  probe.renders += 1
  probe.model = useTabGroupWorkspaceModel({ groupId: 'group-1', worktreeId: 'wt-1' })
  return null
}

describe('useTabGroupWorkspaceModel render stability', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    useAppStore.setState(buildState() as never, true)
    probe.renders = 0
    probe.model = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Probe />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('does not re-render when the global terminal layout record changes', async () => {
    const rendersBefore = probe.renders

    await act(async () => {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          'terminal-1': {
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
          }
        }
      } as never)
    })

    // Why: PTY spawn/attach/reattach writes this record; subscribing to it
    // re-rendered every mounted worktree's tab strip (STA-3328 amplifier).
    expect(probe.renders).toBe(rendersBefore)
  })

  it('keeps commands referentially stable across unrelated store-driven re-renders', async () => {
    const commandsBefore = probe.model!.commands
    const rendersBefore = probe.renders

    await act(async () => {
      useAppStore.setState({ expandedPaneByTabId: { 'terminal-1': 7 } } as never)
    })

    // The subscribed field change must re-render the hook...
    expect(probe.renders).toBeGreaterThan(rendersBefore)
    // ...but commands must keep its identity so TabBar's React.memo can bail.
    expect(probe.model!.commands).toBe(commandsBefore)
  })
})
