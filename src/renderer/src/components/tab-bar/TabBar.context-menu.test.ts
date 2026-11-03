import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expandNode } from './tab-bar-dropdown-menu-item-probe'
import {
  stubHeadlessReact,
  stubShallowSelector,
  stubTooltip
} from './tab-bar-windows-shell-launch-render-stubs'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const appStoreSnapshot: {
  activeTabId: string | null
  activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator' | null
  unifiedTabsByWorktree: Record<string, unknown[]>
  activeGroupIdByWorktree: Record<string, string>
} = {
  activeTabId: 'old-terminal',
  activeTabType: 'terminal',
  unifiedTabsByWorktree: {},
  activeGroupIdByWorktree: {}
}
const pinTabMock: (tabId: string) => void = vi.fn()
const unpinTabMock: (tabId: string) => void = vi.fn()

const useAppStoreMock = vi.fn(
  (
    selector: (state: {
      activeTabId: string | null
      activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator' | null
      gitStatusByWorktree: Record<string, never[]>
      repos: never[]
      worktreesByRepo: Record<string, never[]>
      unifiedTabsByWorktree: Record<string, unknown[]>
      activeGroupIdByWorktree: Record<string, string>
      pinTab: typeof pinTabMock
      unpinTab: typeof unpinTabMock
      settings: {
        terminalWindowsShell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe' | 'git-bash'
        terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
      }
    }) => unknown
  ) =>
    selector({
      activeTabId: appStoreSnapshot.activeTabId,
      activeTabType: appStoreSnapshot.activeTabType,
      gitStatusByWorktree: {},
      repos: [],
      worktreesByRepo: {},
      unifiedTabsByWorktree: appStoreSnapshot.unifiedTabsByWorktree,
      activeGroupIdByWorktree: appStoreSnapshot.activeGroupIdByWorktree,
      pinTab: pinTabMock,
      unpinTab: unpinTabMock,
      settings: {
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'auto'
      }
    })
)

vi.mock('react', async () => await stubHeadlessReact())
vi.mock('@/store/plugin-new-files', () => ({ usePluginNewFiles: () => [] }))
vi.mock('zustand/react/shallow', () => stubShallowSelector())
// The headless React stub has no dispatcher for the hook each tab row subscribes to language changes with.
vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react-i18next')),
  useTranslation: () => ({})
}))

vi.mock('lucide-react', async () => (await import('./lucide-icon-stub-fixture')).stubEveryIcon())

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: function SortableContext(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('./tab-strip-drag-scroll', () => ({
  useTabStripDragScrollHandlers: () => ({
    isTabDragActive: false,
    onDragScrollStartEnter: vi.fn(),
    onDragScrollEndEnter: vi.fn(),
    onDragScrollLeave: vi.fn()
  })
}))

const useAppStoreExport = (selector: Parameters<typeof useAppStoreMock>[0]): unknown =>
  useAppStoreMock(selector)
useAppStoreExport.getState = vi.fn(() => ({
  activeTabId: appStoreSnapshot.activeTabId,
  activeTabType: appStoreSnapshot.activeTabType,
  gitStatusByWorktree: {},
  repos: [],
  worktreesByRepo: {},
  unifiedTabsByWorktree: appStoreSnapshot.unifiedTabsByWorktree,
  activeGroupIdByWorktree: appStoreSnapshot.activeGroupIdByWorktree,
  pinTab: pinTabMock,
  unpinTab: unpinTabMock,
  settings: {
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'auto'
  }
}))

vi.mock('../../store', () => ({
  useAppStore: useAppStoreExport
}))

vi.mock('../right-sidebar/status-display', () => ({
  buildStatusMap: () => new Map()
}))

vi.mock('../tab-group/tab-insertion', () => ({
  resolveTabIndicatorEdges: () => []
}))

vi.mock('@/components/editor/editor-labels', () => ({
  getEditorDisplayLabel: () => ''
}))

vi.mock('./SortableTab', () => ({
  default: function SortableTab(props: Record<string, unknown>) {
    return { type: 'SortableTab', props }
  }
}))

vi.mock('./TerminalSortableTab', () => ({
  default: function SortableTab(props: Record<string, unknown>) {
    return { type: 'SortableTab', props }
  }
}))

vi.mock('./EditorFileTab', () => ({
  default: function EditorFileTab(props: Record<string, unknown>) {
    return { type: 'EditorFileTab', props }
  }
}))

vi.mock('./BrowserTab', () => ({
  default: function BrowserTab(props: Record<string, unknown>) {
    return { type: 'BrowserTab', props }
  },
  getBrowserTabLabel: () => ''
}))

vi.mock('./QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: function QuickLaunchAgentMenuItems() {
    return null
  },
  ProjectedAgentMenuItems: function ProjectedAgentMenuItems() {
    return null
  },
  useTabAgentMenuLaunch: () => () => undefined
}))

vi.mock('./shell-icons', () => ({
  ShellIcon: function ShellIcon() {
    return null
  }
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu(props: { children?: unknown }) {
    return { type: 'DropdownMenu', props }
  },
  DropdownMenuContent: function DropdownMenuContent(props: { children?: unknown }) {
    return { type: 'DropdownMenuContent', props }
  },
  DropdownMenuItem: function DropdownMenuItem(props: {
    children?: unknown
    onSelect?: () => void
  }) {
    return { type: 'DropdownMenuItem', props }
  },
  DropdownMenuSeparator: function DropdownMenuSeparator() {
    return { type: 'DropdownMenuSeparator', props: {} }
  },
  DropdownMenuShortcut: function DropdownMenuShortcut(props: { children?: unknown }) {
    return { type: 'DropdownMenuShortcut', props }
  },
  DropdownMenuLabel: function DropdownMenuLabel(props: { children?: unknown }) {
    return { type: 'DropdownMenuLabel', props }
  },
  DropdownMenuSub: function DropdownMenuSub(props: { children?: unknown }) {
    return { type: 'DropdownMenuSub', props }
  },
  DropdownMenuSubContent: function DropdownMenuSubContent(props: { children?: unknown }) {
    return { type: 'DropdownMenuSubContent', props }
  },
  DropdownMenuSubTrigger: function DropdownMenuSubTrigger(props: { children?: unknown }) {
    return { type: 'DropdownMenuSubTrigger', props }
  },
  DropdownMenuTrigger: function DropdownMenuTrigger(props: { children?: unknown }) {
    return { type: 'DropdownMenuTrigger', props }
  }
}))

vi.mock('@/components/ui/tooltip', () => stubTooltip())

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
  ref?: unknown
}

function findChildrenByType(node: unknown, typeName: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  const visit = (current: unknown): void => {
    if (current == null) {
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child)
      }
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      return
    }
    const el = current as ReactElementLike
    const type = el.type as { name?: string } | string | undefined
    const matchedName = typeof type === 'string' ? type : type?.name
    if (matchedName === typeName) {
      results.push(el)
    }
    if (matchedName === 'TabBarStaticCreateMenu' && typeof el.type === 'function') {
      // Expand the deferred pure menu component in this shallow renderer.
      visit(el.type(el.props))
      return
    }
    if (el.props && 'children' in el.props) {
      visit(el.props.children)
    }
  }
  visit(node)
  return results
}

function extractText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }
  const el = node as ReactElementLike
  return el.props && 'children' in el.props ? extractText(el.props.children) : ''
}

async function renderTabBar(props: Record<string, unknown>): Promise<unknown> {
  const tabBarModule = await import('./TabBar')
  const candidate = tabBarModule.default as unknown as
    | ((props: Record<string, unknown>) => unknown)
    | { type: (props: Record<string, unknown>) => unknown }
  const TabBar = typeof candidate === 'function' ? candidate : candidate.type
  return expandNode(
    TabBar({
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onCloseToLeft: () => {},
      onNewTerminalTab: () => {},
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {},
      ...props
    })
  )
}

const TERMINAL_TAB = {
  id: 'term-1',
  unifiedTabId: 'unified-term-1',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

describe('TabBar context menu wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.useRealTimers()
    appStoreSnapshot.activeTabId = 'old-terminal'
    appStoreSnapshot.activeTabType = 'terminal'
    appStoreSnapshot.unifiedTabsByWorktree = {}
    appStoreSnapshot.activeGroupIdByWorktree = {}
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits for async menu-created terminals before focusing xterm', async () => {
    vi.useFakeTimers()
    Object.assign(window, { setTimeout, clearTimeout })
    const { focusTerminalTabSurface } = await import('@/lib/focus-terminal-tab-surface')
    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      activeTabId: 'old-terminal',
      activeTabType: 'terminal',
      onNewTerminalTab: () => {
        window.setTimeout(() => {
          appStoreSnapshot.activeTabId = 'new-terminal'
          appStoreSnapshot.activeTabType = 'terminal'
        }, 100)
      }
    })

    const menuItems = findChildrenByType(element, 'DropdownMenuItem')
    const newTerminalItem = menuItems[0]
    const menuContent = findChildrenByType(element, 'DropdownMenuContent')[0]
    expect(newTerminalItem).toBeTruthy()
    expect(menuContent).toBeTruthy()

    ;(newTerminalItem.props.onSelect as () => void)()
    ;(menuContent.props.onCloseAutoFocus as (event: { preventDefault: () => void }) => void)({
      preventDefault: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('new-terminal')
    expect(focusTerminalTabSurface).not.toHaveBeenCalledWith('old-terminal')
  })

  it('omits impossible paired-web actions while keeping terminal and markdown', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      onNewFileTab: () => {},
      onOpenFileTab: () => {},
      onNewSimulatorTab: () => {}
    })

    const menuLabels = findChildrenByType(element, 'DropdownMenuItem').map((item) =>
      extractText(item.props.children)
    )

    expect(menuLabels.some((label) => label.includes('New Terminal'))).toBe(true)
    expect(menuLabels.some((label) => label.includes('New Markdown'))).toBe(true)
    expect(menuLabels.some((label) => label.includes('Open Markdown...'))).toBe(true)
    expect(menuLabels.some((label) => label.includes('Browser'))).toBe(false)
    expect(menuLabels.some((label) => label.includes('Mobile Emulator'))).toBe(false)
  })

  it('cancels delayed menu focus when the tab bar root unmounts', async () => {
    vi.useFakeTimers()
    Object.assign(window, { setTimeout, clearTimeout })
    const { focusTerminalTabSurface } = await import('@/lib/focus-terminal-tab-surface')
    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      activeTabId: 'old-terminal',
      activeTabType: 'terminal',
      onNewTerminalTab: () => {
        window.setTimeout(() => {
          appStoreSnapshot.activeTabId = 'new-terminal'
          appStoreSnapshot.activeTabType = 'terminal'
        }, 100)
      }
    })

    const newTerminalItem = findChildrenByType(element, 'DropdownMenuItem')[0]
    const menuContent = findChildrenByType(element, 'DropdownMenuContent')[0]
    ;(newTerminalItem.props.onSelect as () => void)()
    ;(menuContent.props.onCloseAutoFocus as (event: { preventDefault: () => void }) => void)({
      preventDefault: vi.fn()
    })

    const root = findChildrenByType(element, 'div')[0]
    const rootRef = (root.props.ref ?? root.ref) as (node: HTMLDivElement | null) => void
    rootRef(null)

    await vi.advanceTimersByTimeAsync(5000)
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})
