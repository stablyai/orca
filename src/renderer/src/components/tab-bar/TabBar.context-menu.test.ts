import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useAppStoreMock = vi.fn(
  (
    selector: (state: {
      gitStatusByWorktree: Record<string, never[]>
      settings: {
        terminalWindowsShell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe'
        terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
      }
    }) => unknown
  ) =>
    selector({
      gitStatusByWorktree: {},
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
  TerminalSquare: function TerminalSquare() {
    return null
  }
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: function SortableContext(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: Parameters<typeof useAppStoreMock>[0]) => useAppStoreMock(selector)
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

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
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
    wslAvailable: false,
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
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
  })

  afterEach(() => {
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
})
