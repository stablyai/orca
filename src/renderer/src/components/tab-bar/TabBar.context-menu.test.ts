/* oxlint-disable max-lines -- Why: keeping these mocked TabBar wiring cases
 * together avoids duplicating the lightweight renderer harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    memo: <T>(component: T) => component,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: <T>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(current: T) => ({ current }),
    useState: <T>(initial: T) => [initial, vi.fn()] as const
  }
})

vi.mock('lucide-react', () => ({
  FilePlus: function FilePlus() {
    return null
  },
  FileText: function FileText() {
    return null
  },
  Globe: function Globe() {
    return null
  },
  Plus: function Plus() {
    return null
  },
  Smartphone: function Smartphone() {
    return null
  },
  TerminalSquare: function TerminalSquare() {
    return null
  }
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: function SortableContext(props: { children?: unknown }) {
    return props.children
  }
}))

const useAppStoreExport = (selector: Parameters<typeof useAppStoreMock>[0]): unknown =>
  useAppStoreMock(selector)
useAppStoreExport.getState = vi.fn(() => ({
  activeTabId: appStoreSnapshot.activeTabId,
  activeTabType: appStoreSnapshot.activeTabType,
  gitStatusByWorktree: {},
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
  }
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
  DropdownMenuTrigger: function DropdownMenuTrigger(props: { children?: unknown }) {
    return { type: 'DropdownMenuTrigger', props }
  }
}))

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
  return TabBar({
    activeTabId: null,
    worktreeId: 'wt-1',
    expandedPaneByTabId: {},
    onActivate: () => {},
    onClose: () => {},
    onCloseOthers: () => {},
    onCloseToRight: () => {},
    onNewTerminalTab: () => {},
    onNewBrowserTab: () => {},
    onSetCustomTitle: () => {},
    onSetTabColor: () => {},
    onTogglePaneExpand: () => {},
    ...props
  })
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

const EDITOR_FILE = {
  id: 'file-1',
  tabId: 'unified-editor-1',
  worktreeId: 'wt-1',
  relativePath: 'foo.ts',
  isDirty: false
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

  it('counts every tab kind for SortableTab.tabCount', async () => {
    // Why: Close Others used to pass tabCount=tabs.length, where tabs is just the
    // terminal list. With one terminal + any number of editor/browser tabs, the
    // menu item rendered as disabled even though closeOthers can close the
    // non-terminal siblings.
    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      editorFiles: [EDITOR_FILE],
      browserTabs: [],
      tabBarOrder: ['term-1', 'unified-editor-1']
    })
    const sortable = findChildrenByType(element, 'SortableTab')
    expect(sortable).toHaveLength(1)
    expect(sortable[0].props.tabCount).toBe(2)
  })

  it('keeps the tab strip content-sized until horizontal scrolling is needed', async () => {
    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      editorFiles: [EDITOR_FILE],
      browserTabs: [],
      tabBarOrder: ['term-1', 'unified-editor-1']
    })
    const divs = findChildrenByType(element, 'div')
    const stripWrapper = divs.find((candidate) =>
      String(candidate.props.className ?? '').includes('flex-[0_1_auto]')
    )
    const strip = divs.find((candidate) =>
      String(candidate.props.className ?? '').includes('terminal-tab-strip')
    )

    expect(stripWrapper).toBeTruthy()
    expect(stripWrapper?.props.className).toContain('min-w-0')
    expect(stripWrapper?.props.className).toContain('max-w-full')
    expect(strip).toBeTruthy()
    expect(strip?.props.className).toContain('min-w-0')
    expect(strip?.props.className).toContain('flex-1')
    expect(strip?.props.className).toContain('overflow-x-auto')
    expect(strip?.props.className).not.toContain('scrollbar-sleek')
  })

  it('passes the editor unifiedTabId when EditorFileTab triggers onCloseToRight', async () => {
    // Why: TabBar wires the editor tab as () => onCloseToRight(item.id). The
    // emitted id is the editor's unifiedTabId (item.id for editors), not the
    // file entityId. TabGroupPanel must accept this id shape to close right-side
    // tabs from an editor tab — see the matching id|entityId resolver there.
    const onCloseToRight = vi.fn()
    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      editorFiles: [EDITOR_FILE],
      browserTabs: [],
      tabBarOrder: ['term-1', 'unified-editor-1'],
      onCloseToRight
    })
    const editorTabs = findChildrenByType(element, 'EditorFileTab')
    expect(editorTabs).toHaveLength(1)
    const onClose = editorTabs[0].props.onCloseToRight as () => void
    onClose()
    expect(onCloseToRight).toHaveBeenCalledWith('unified-editor-1')
  })

  it('passes pinned state and toggles unpin through the unified tab id', async () => {
    appStoreSnapshot.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'unified-term-1',
          entityId: 'term-1',
          groupId: 'wt-1',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0,
          isPinned: true
        }
      ]
    }

    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      editorFiles: [],
      browserTabs: [],
      tabBarOrder: ['term-1']
    })

    const sortable = findChildrenByType(element, 'SortableTab')
    expect(sortable).toHaveLength(1)
    expect(sortable[0].props.isPinned).toBe(true)

    ;(sortable[0].props.onTogglePin as () => void)()

    expect(unpinTabMock).toHaveBeenCalledWith('unified-term-1')
    expect(pinTabMock).not.toHaveBeenCalled()
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

  it('can put markdown actions before terminal actions in the new-tab menu', async () => {
    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      onNewFileTab: () => {},
      onOpenFileTab: () => {},
      newTabMenuOrder: 'markdown-first'
    })

    const menuLabels = findChildrenByType(element, 'DropdownMenuItem').map((item) =>
      extractText(item.props.children)
    )

    expect(menuLabels[0]).toContain('New Markdown')
    expect(menuLabels[1]).toBe('Open Markdown...')
    expect(menuLabels[2]).toContain('New Terminal')
    expect(menuLabels[3]).toContain('New Browser Tab')
  })

  it('turns New Mobile Emulator into a go-to action when the workspace already has one', async () => {
    const onNewSimulatorTab = vi.fn()
    appStoreSnapshot.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'sim-1',
          entityId: 'sim-1',
          groupId: 'group-2',
          worktreeId: 'wt-1',
          contentType: 'simulator',
          label: 'Mobile Emulator',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 0
        }
      ]
    }

    const element = await renderTabBar({
      tabs: [TERMINAL_TAB],
      groupId: 'group-1',
      onNewSimulatorTab
    })

    const emulatorItem = findChildrenByType(element, 'DropdownMenuItem').find((item) =>
      extractText(item.props.children).includes('Go to Mobile Emulator')
    )
    expect(emulatorItem).toBeTruthy()
    if (!emulatorItem) {
      throw new Error('Go to Mobile Emulator menu item not rendered')
    }
    expect(emulatorItem.props.disabled).toBeUndefined()
    expect(emulatorItem.props.onSelect).toBeTypeOf('function')
    ;(emulatorItem.props.onSelect as () => void)()
    expect(onNewSimulatorTab).toHaveBeenCalledTimes(1)

    const tooltip = findChildrenByType(element, 'TooltipContent').find((item) =>
      extractText(item.props.children).includes('Open the existing emulator tab.')
    )
    expect(tooltip).toBeTruthy()
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
