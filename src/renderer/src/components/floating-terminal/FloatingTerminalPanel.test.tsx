import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TerminalTab } from '../../../../shared/types'

type EffectCallback = () => void | (() => void)

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

type FloatingPanelStoreState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabIdByWorktree: Record<string, string | null>
  expandedPaneByTabId: Record<string, boolean>
  createTab: (
    worktreeId: string,
    groupId?: string,
    shellOverride?: string,
    options?: { activate?: boolean }
  ) => TerminalTab
  closeTab: (tabId: string) => void
  setActiveTabForWorktree: (worktreeId: string, tabId: string) => void
  setTabBarOrder: (worktreeId: string, order: string[]) => void
  setTabCustomTitle: (tabId: string, title: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  tabBarOrderByWorktree: Record<string, string[]>
  settings: { floatingTerminalCwd?: string }
}

const hookRuntime = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  index: 0,
  values: [] as unknown[]
}))

const storeBox = vi.hoisted(() => ({
  state: null as unknown
}))

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  createTab: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  getFloatingTerminalCwd: vi.fn(),
  getInstallStatus: vi.fn(),
  setActiveTabForWorktree: vi.fn(),
  setTabBarOrder: vi.fn(),
  setTabColor: vi.fn(),
  setTabCustomTitle: vi.fn(),
  setTabPaneExpanded: vi.fn()
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: EffectCallback) => {
      hookRuntime.effects.push(effect)
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initialValue: T) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] = { current: initialValue }
      }
      return hookRuntime.values[index] as { current: T }
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] =
          typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
      }
      const setValue = (nextValue: T | ((current: T) => T)): void => {
        hookRuntime.values[index] =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(hookRuntime.values[index] as T)
            : nextValue
      }
      return [hookRuntime.values[index] as T, setValue] as const
    }
  }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: FloatingPanelStoreState) => unknown) =>
      selector(storeBox.state as FloatingPanelStoreState),
    {
      getState: () => storeBox.state as FloatingPanelStoreState
    }
  )
  return { useAppStore }
})

vi.mock('@/components/tab-bar/TabBar', () => ({
  default: function TabBar() {
    return null
  }
}))

vi.mock('@/components/terminal-pane/TerminalPane', () => ({
  default: function TerminalPane() {
    return null
  }
}))

vi.mock('@/components/ui/button', () => ({
  Button: function Button() {
    return null
  }
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/orchestration-setup-state', () => ({
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY: 'floating-terminal-test-dismissed',
  ORCHESTRATION_SETUP_STATE_EVENT: 'floating-terminal-test-setup-state',
  hasOrchestrationSetupMarker: vi.fn(() => true),
  isOrchestrationSetupDismissed: vi.fn(() => false),
  notifyOrchestrationSetupStateChanged: vi.fn()
}))

vi.mock('./FloatingTerminalOrchestrationDialog', () => ({
  FloatingTerminalOrchestrationDialog: function FloatingTerminalOrchestrationDialog() {
    return null
  }
}))

vi.mock('./FloatingTerminalResizeHandles', () => ({
  FloatingTerminalResizeHandles: function FloatingTerminalResizeHandles() {
    return null
  }
}))

vi.mock('./FloatingTerminalToggleButton', () => ({
  FloatingTerminalToggleButton: function FloatingTerminalToggleButton() {
    return null
  }
}))

vi.mock('./FloatingTerminalWindowControls', () => ({
  FloatingTerminalWindowControls: function FloatingTerminalWindowControls() {
    return null
  }
}))

vi.mock('./floating-terminal-panel-bounds', () => ({
  clampFloatingTerminalBounds: (bounds: unknown) => bounds,
  getDefaultFloatingTerminalBounds: () => ({ height: 480, left: 20, top: 20, width: 720 }),
  getMaximizedFloatingTerminalBounds: () => ({ height: 700, left: 0, top: 0, width: 1000 })
}))

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? null,
    worktreeId: overrides.worktreeId ?? FLOATING_TERMINAL_WORKTREE_ID,
    title: overrides.title ?? 'Terminal',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    ...overrides
  }
}

function setFloatingTabs(tabs: TerminalTab[]): void {
  const state = storeBox.state as FloatingPanelStoreState
  state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs }
  state.activeTabIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs[0]?.id ?? null }
  state.tabBarOrderByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.map((tab) => tab.id) }
}

function resetStore(tabs: TerminalTab[] = []): void {
  storeBox.state = {
    tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs },
    activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs[0]?.id ?? null },
    expandedPaneByTabId: {},
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    setActiveTabForWorktree: mocks.setActiveTabForWorktree,
    setTabBarOrder: mocks.setTabBarOrder,
    setTabCustomTitle: mocks.setTabCustomTitle,
    setTabColor: mocks.setTabColor,
    setTabPaneExpanded: mocks.setTabPaneExpanded,
    tabBarOrderByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.map((tab) => tab.id) },
    settings: { floatingTerminalCwd: '~' }
  } satisfies FloatingPanelStoreState
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  if (!element.props) {
    return
  }
  cb(element)
  visit(element.props.children, cb)
}

function findByTypeName(node: unknown, typeName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    const candidate =
      typeof entry.type === 'function' || typeof entry.type === 'object'
        ? ((entry.type as { displayName?: string; name?: string }).displayName ??
          (entry.type as { displayName?: string; name?: string }).name ??
          '')
        : entry.type
    if (candidate === typeName) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${typeName} not found`)
  }
  return found
}

function runEffects(): void {
  const effects = hookRuntime.effects.splice(0)
  for (const effect of effects) {
    effect()
  }
}

async function renderPanel(open: boolean, onOpenChange = vi.fn()): Promise<unknown> {
  hookRuntime.index = 0
  const { FloatingTerminalPanel } = await import('./FloatingTerminalPanel')
  return FloatingTerminalPanel({ open, onOpenChange })
}

describe('FloatingTerminalPanel close behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hookRuntime.effects = []
    hookRuntime.index = 0
    hookRuntime.values = []
    resetStore()
    mocks.createTab.mockReturnValue(makeTab({ id: 'created-tab' }))
    mocks.getFloatingTerminalCwd.mockResolvedValue('/tmp/orca')
    mocks.getInstallStatus.mockResolvedValue({ state: 'installed' })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      api: {
        app: { getFloatingTerminalCwd: mocks.getFloatingTerminalCwd },
        cli: { getInstallStatus: mocks.getInstallStatus }
      },
      innerWidth: 1200,
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('localStorage', { setItem: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('bootstraps a terminal tab only when the panel opens', async () => {
    await renderPanel(false)
    runEffects()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(true)
    runEffects()
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveTabForWorktree).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'created-tab'
    )

    await renderPanel(true)
    runEffects()
    expect(mocks.createTab).toHaveBeenCalledTimes(1)

    await renderPanel(false)
    runEffects()
    await renderPanel(true)
    runEffects()
    expect(mocks.createTab).toHaveBeenCalledTimes(2)
  })

  it('closes the panel when the explicit close action removes the last tab', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderPanel(true, onOpenChange)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the panel open when the explicit close action leaves another tab', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([
      makeTab({ id: 'tab-1', sortOrder: 0 }),
      makeTab({ id: 'tab-2', sortOrder: 1 })
    ])

    const element = await renderPanel(true, onOpenChange)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-2')

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-2')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps PTY exit separate from explicit terminal pane close', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    await renderPanel(true, onOpenChange)
    runEffects()
    await Promise.resolve()
    const element = await renderPanel(true, onOpenChange)
    const terminalPane = findByTypeName(element, 'TerminalPane')

    ;(terminalPane.props.onPtyExit as () => void)()
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(onOpenChange).not.toHaveBeenCalled()

    mocks.closeTab.mockClear()
    ;(terminalPane.props.onCloseTab as () => void)()
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reads the current tab list for bulk close actions', async () => {
    setFloatingTabs([makeTab({ id: 'old-left' }), makeTab({ id: 'old-keep' })])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    setFloatingTabs([
      makeTab({ id: 'new-left', sortOrder: 0 }),
      makeTab({ id: 'new-keep', sortOrder: 1 }),
      makeTab({ id: 'new-right', sortOrder: 2 })
    ])

    ;(tabBar.props.onCloseOthers as (tabId: string) => void)('new-keep')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-left')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-right')
    expect(mocks.closeTab).not.toHaveBeenCalledWith('old-left')

    mocks.closeTab.mockClear()
    ;(tabBar.props.onCloseToRight as (tabId: string) => void)('new-left')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-keep')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-right')
    expect(mocks.closeTab).not.toHaveBeenCalledWith('old-keep')
  })

  it('closes tabs to the right using visible tab order', async () => {
    setFloatingTabs([
      makeTab({ id: 'tab-a', sortOrder: 0 }),
      makeTab({ id: 'tab-b', sortOrder: 1 }),
      makeTab({ id: 'tab-c', sortOrder: 2 })
    ])
    ;(storeBox.state as FloatingPanelStoreState).tabBarOrderByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: ['tab-c', 'tab-a', 'tab-b']
    }

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseToRight as (tabId: string) => void)('tab-c')

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-a')
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-b')
    expect(mocks.closeTab).not.toHaveBeenCalledWith('tab-c')
  })
})
