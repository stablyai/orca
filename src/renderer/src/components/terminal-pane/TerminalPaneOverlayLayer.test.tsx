import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, TerminalTab } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  closeTerminalTab: vi.fn(),
  consumeSuppressedPtyExit: vi.fn(() => false),
  focusGroup: vi.fn(),
  reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
  setActiveWorktree: vi.fn()
}))

type OverlayStoreState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string | null | undefined>
  activeWorktreeId: string | null
  pendingStartupByTabId: Record<string, boolean>
  focusGroup: typeof mocks.focusGroup
  consumeSuppressedPtyExit: typeof mocks.consumeSuppressedPtyExit
  closeTab: typeof mocks.closeTab
  setActiveWorktree: typeof mocks.setActiveWorktree
  reconcileWorktreeTabModel: typeof mocks.reconcileWorktreeTabModel
}

const storeBox = vi.hoisted(() => ({
  state: null as OverlayStoreState | null
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initial: T) => ({ current: initial }),
    // Why: main's cold-parking hook seeds state lazily (`useState(() => new Set())`),
    // so the stub must invoke function initializers like real React.
    useState: <T,>(initial: T | (() => T)) =>
      [typeof initial === 'function' ? (initial as () => T)() : initial, vi.fn()] as const,
    useLayoutEffect: () => undefined,
    useEffect: () => undefined,
    memo: <T,>(component: T) => component
  }
})

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector
}))

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: OverlayStoreState) => unknown) =>
      selector(storeBox.state as OverlayStoreState),
    {
      getState: () => storeBox.state as OverlayStoreState
    }
  )
  return { useAppStore }
})

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node
}))

vi.mock('./TerminalPane', () => ({
  default: (props: Record<string, unknown>) => ({ __mock: 'TerminalPane', props })
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))

import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'

type ReactElementLike = {
  type: string | ((props: Record<string, unknown>) => unknown)
  props: Record<string, unknown>
}

function collectTerminalPaneProps(node: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (current: unknown): void => {
    if (current == null || typeof current !== 'object') {
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    const mockNode = current as { __mock?: string; props?: Record<string, unknown> }
    if (mockNode.__mock === 'TerminalPane' && mockNode.props) {
      found.push(mockNode.props)
      return
    }
    const element = current as ReactElementLike
    if (typeof element.type === 'function') {
      visit(element.type(element.props ?? {}))
      return
    }
    if (element.props) {
      visit(element.props.children)
    }
  }
  visit(node)
  return found
}

function makeTerminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: 'wt-1',
    title: id,
    defaultTitle: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  } as TerminalTab
}

function makeUnifiedTerminalTab(entityId: string, groupId: string): Tab {
  return {
    id: `unified-${entityId}`,
    entityId,
    groupId,
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  } as Tab
}

function seedStore(activeTabId: string): void {
  storeBox.state = {
    tabsByWorktree: { 'wt-1': [makeTerminalTab('term-1'), makeTerminalTab('term-2')] },
    unifiedTabsByWorktree: {
      'wt-1': [
        makeUnifiedTerminalTab('term-1', 'group-1'),
        makeUnifiedTerminalTab('term-2', 'group-1')
      ]
    },
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId,
          tabOrder: ['unified-term-1', 'unified-term-2']
        } as TabGroup
      ]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    activeWorktreeId: 'wt-1',
    // Why: main's overlay slot seeds hidden-startup measuring from
    // pendingStartupByTabId at first render; an empty record means no
    // pending startups, matching the default store shape.
    pendingStartupByTabId: {},
    focusGroup: mocks.focusGroup,
    consumeSuppressedPtyExit: mocks.consumeSuppressedPtyExit,
    closeTab: mocks.closeTab,
    setActiveWorktree: mocks.setActiveWorktree,
    reconcileWorktreeTabModel: mocks.reconcileWorktreeTabModel
  }
}

function renderOverlay(isWorktreeActive: boolean): Record<string, unknown>[] {
  const element = TerminalPaneOverlayLayer({
    worktreeId: 'wt-1',
    worktreePath: '/worktree',
    isWorktreeActive
  })
  return collectTerminalPaneProps(element)
}

function paneFor(panes: Record<string, unknown>[], tabId: string): Record<string, unknown> {
  const pane = panes.find((props) => props.tabId === tabId)
  if (!pane) {
    throw new Error(`expected an overlay pane for ${tabId}`)
  }
  return pane
}

describe('TerminalPaneOverlayLayer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.consumeSuppressedPtyExit.mockReturnValue(false)
    mocks.reconcileWorktreeTabModel.mockReturnValue({ renderableTabCount: 0 })
    seedStore('unified-term-1')
  })

  it('shows only the active-in-group terminal while the worktree is active', () => {
    const panes = renderOverlay(true)
    const first = panes.find((props) => props.tabId === 'term-1')
    const second = panes.find((props) => props.tabId === 'term-2')

    expect(first?.isVisible).toBe(true)
    expect(first?.isActive).toBe(true)
    expect(second?.isVisible).toBe(false)
    expect(second?.isActive).toBe(false)
  })

  it('hides every terminal pane while the worktree is inactive', () => {
    const panes = renderOverlay(false)

    for (const props of panes) {
      expect(props.isVisible).toBe(false)
      expect(props.isActive).toBe(false)
    }
  })

  it('closes the tab and re-checks the worktree on a genuine PTY exit', () => {
    const panes = renderOverlay(true)
    const first = paneFor(panes, 'term-1')

    ;(first.onPtyExit as (ptyId: string) => void)('pty-term-1')

    // Why: PTY exits route through the pinned-aware helper, never the raw
    // store closeTab; the worktree re-check runs in the onClosed continuation.
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith('term-1', {
      reason: 'pty-exit',
      onClosed: expect.any(Function)
    })
    const { onClosed } = mocks.closeTerminalTab.mock.calls[0][1] as { onClosed: () => void }
    onClosed()
    expect(mocks.reconcileWorktreeTabModel).toHaveBeenCalledWith('wt-1')
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(null)
  })

  it('keeps the tab open when a PTY exit is suppressed', () => {
    mocks.consumeSuppressedPtyExit.mockReturnValue(true)
    const panes = renderOverlay(true)
    const first = paneFor(panes, 'term-1')

    ;(first.onPtyExit as (ptyId: string) => void)('pty-term-1')

    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('routes an explicit pane close through the pinned-aware close helper', () => {
    const panes = renderOverlay(true)
    const first = paneFor(panes, 'term-1')

    ;(first.onCloseTab as () => void)()

    expect(mocks.closeTerminalTab).toHaveBeenCalledWith('term-1', {
      onClosed: expect.any(Function)
    })
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })
})
