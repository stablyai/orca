/* oxlint-disable max-lines -- Why: TabBar Windows shell tests share a large
   mocked dropdown/render harness; keeping shell variants together prevents
   fixture drift across PowerShell, WSL, and Git Bash cases. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appStoreSnapshot: {
  activeRepoId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator' | null
  activeRuntimeEnvironmentId: string | null
  activeWorktreeId: string | null
  projects: {
    id: string
    localWindowsRuntimePreference?:
      | { kind: 'inherit-global' | 'windows-host' }
      | {
          kind: 'wsl'
          distro: string
        }
    sourceRepoIds?: string[]
  }[]
  repos: { id: string; connectionId?: string | null }[]
  worktreesByRepo: Record<
    string,
    { id: string; repoId: string; path?: string; projectId?: string }[]
  >
  unifiedTabsByWorktree: Record<string, unknown[]>
  activeGroupIdByWorktree: Record<string, string>
  detectedAgentIds: string[] | null
  remoteDetectedAgentIds: Record<string, string[]>
  isDetectingAgents: boolean
  isDetectingRemoteAgents: Record<string, boolean>
} = {
  activeRepoId: null,
  activeTabId: null,
  activeTabType: null,
  activeRuntimeEnvironmentId: null,
  activeWorktreeId: null,
  projects: [],
  repos: [],
  worktreesByRepo: {},
  unifiedTabsByWorktree: {},
  activeGroupIdByWorktree: {},
  detectedAgentIds: null,
  remoteDetectedAgentIds: {},
  isDetectingAgents: false,
  isDetectingRemoteAgents: {}
}
const pinTabMock: (tabId: string) => void = vi.fn()
const unpinTabMock: (tabId: string) => void = vi.fn()

const useAppStoreMock = vi.fn(
  (
    selector: (state: {
      activeRepoId: string | null
      activeTabId: string | null
      activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator' | null
      activeWorktreeId: string | null
      gitStatusByWorktree: Record<string, never[]>
      projects: typeof appStoreSnapshot.projects
      repos: { id: string; connectionId?: string | null }[]
      worktreesByRepo: typeof appStoreSnapshot.worktreesByRepo
      unifiedTabsByWorktree: Record<string, unknown[]>
      activeGroupIdByWorktree: Record<string, string>
      detectedAgentIds: string[] | null
      remoteDetectedAgentIds: Record<string, string[]>
      isDetectingAgents: boolean
      isDetectingRemoteAgents: Record<string, boolean>
      pinTab: typeof pinTabMock
      unpinTab: typeof unpinTabMock
      settings: {
        terminalWindowsShell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe' | 'git-bash'
        terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
        activeRuntimeEnvironmentId: string | null
        localWindowsRuntimeDefault: { kind: 'windows-host' } | { kind: 'wsl'; distro: string }
      }
    }) => unknown
  ) =>
    selector({
      activeRepoId: appStoreSnapshot.activeRepoId,
      activeTabId: appStoreSnapshot.activeTabId,
      activeTabType: appStoreSnapshot.activeTabType,
      activeWorktreeId: appStoreSnapshot.activeWorktreeId,
      gitStatusByWorktree: {},
      projects: appStoreSnapshot.projects,
      repos: appStoreSnapshot.repos,
      worktreesByRepo: appStoreSnapshot.worktreesByRepo,
      unifiedTabsByWorktree: appStoreSnapshot.unifiedTabsByWorktree,
      activeGroupIdByWorktree: appStoreSnapshot.activeGroupIdByWorktree,
      detectedAgentIds: appStoreSnapshot.detectedAgentIds,
      remoteDetectedAgentIds: appStoreSnapshot.remoteDetectedAgentIds,
      isDetectingAgents: appStoreSnapshot.isDetectingAgents,
      isDetectingRemoteAgents: appStoreSnapshot.isDetectingRemoteAgents,
      pinTab: pinTabMock,
      unpinTab: unpinTabMock,
      settings: {
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe',
        activeRuntimeEnvironmentId: appStoreSnapshot.activeRuntimeEnvironmentId,
        localWindowsRuntimeDefault: { kind: 'windows-host' }
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
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(current: T) => ({ current }),
    useState: <T>(initial: T | (() => T)) => {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial
      return [value, vi.fn()] as const
    }
  }
})

vi.mock('lucide-react', () => ({
  FilePlus: function FilePlus() {
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
  activeRepoId: appStoreSnapshot.activeRepoId,
  activeTabId: appStoreSnapshot.activeTabId,
  activeTabType: appStoreSnapshot.activeTabType,
  activeWorktreeId: appStoreSnapshot.activeWorktreeId,
  gitStatusByWorktree: {},
  projects: appStoreSnapshot.projects,
  repos: appStoreSnapshot.repos,
  worktreesByRepo: appStoreSnapshot.worktreesByRepo,
  unifiedTabsByWorktree: appStoreSnapshot.unifiedTabsByWorktree,
  activeGroupIdByWorktree: appStoreSnapshot.activeGroupIdByWorktree,
  detectedAgentIds: appStoreSnapshot.detectedAgentIds,
  remoteDetectedAgentIds: appStoreSnapshot.remoteDetectedAgentIds,
  isDetectingAgents: appStoreSnapshot.isDetectingAgents,
  isDetectingRemoteAgents: appStoreSnapshot.isDetectingRemoteAgents,
  pinTab: pinTabMock,
  unpinTab: unpinTabMock,
  settings: {
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'pwsh.exe',
    activeRuntimeEnvironmentId: appStoreSnapshot.activeRuntimeEnvironmentId,
    localWindowsRuntimeDefault: { kind: 'windows-host' }
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
  default: function SortableTab() {
    return null
  }
}))

vi.mock('./EditorFileTab', () => ({
  default: function EditorFileTab() {
    return null
  }
}))

vi.mock('./BrowserTab', () => ({
  default: function BrowserTab() {
    return null
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

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function collectText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const el = node as ReactElementLike
  return collectText(el.props?.children)
}

function expandNode(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(expandNode)
  }
  const el = node as ReactElementLike
  if (typeof el.type === 'function') {
    return expandNode(el.type(el.props))
  }
  return {
    ...el,
    props: {
      ...el.props,
      children: expandNode(el.props?.children)
    }
  }
}

function findDropdownMenuItemByText(node: unknown, text: string): ReactElementLike | null {
  if (node == null) {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDropdownMenuItemByText(child, text)
      if (found) {
        return found
      }
    }
    return null
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return null
  }
  const el = node as ReactElementLike
  if (el.type === 'DropdownMenuItem' && collectText(el.props.children).includes(text)) {
    return el
  }
  return findDropdownMenuItemByText(el.props?.children, text)
}

describe('TabBar PowerShell launch wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    appStoreSnapshot.activeRepoId = null
    appStoreSnapshot.activeTabId = null
    appStoreSnapshot.activeTabType = null
    appStoreSnapshot.activeRuntimeEnvironmentId = null
    appStoreSnapshot.activeWorktreeId = null
    appStoreSnapshot.projects = []
    appStoreSnapshot.repos = []
    appStoreSnapshot.worktreesByRepo = {}
    appStoreSnapshot.unifiedTabsByWorktree = {}
    appStoreSnapshot.activeGroupIdByWorktree = {}
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes pwsh.exe when the PowerShell menu item uses the PowerShell 7+ implementation', async () => {
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(true) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities()

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    const onNewTerminalWithShell = vi.fn()
    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell,
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    const item = findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')
    expect(item).not.toBeNull()

    const onSelect = item?.props.onSelect as (() => void) | undefined
    onSelect?.()

    expect(onNewTerminalWithShell).toHaveBeenCalledWith('pwsh.exe')
  }, 30_000)

  it('hides the WSL terminal row for local host-runtime projects', async () => {
    appStoreSnapshot.activeRepoId = 'repo-1'
    appStoreSnapshot.activeWorktreeId = 'wt-1'
    appStoreSnapshot.projects = [
      {
        id: 'project-1',
        localWindowsRuntimePreference: { kind: 'windows-host' },
        sourceRepoIds: ['repo-1']
      }
    ]
    appStoreSnapshot.repos = [{ id: 'repo-1' }]
    appStoreSnapshot.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: 'C:\\repo',
          projectId: 'project-1'
        }
      ]
    }
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(true),
          listDistros: vi.fn().mockResolvedValue(['Ubuntu'])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities()

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell: () => {},
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')
    ).not.toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).toBeNull()
  })

  it('shows only the WSL terminal row for local WSL-runtime projects', async () => {
    appStoreSnapshot.activeRepoId = 'repo-1'
    appStoreSnapshot.projects = [
      {
        id: 'project-1',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        sourceRepoIds: ['repo-1']
      }
    ]
    appStoreSnapshot.repos = [{ id: 'repo-1' }]
    appStoreSnapshot.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: 'C:\\repo',
          projectId: 'project-1'
        }
      ]
    }
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(true),
          listDistros: vi.fn().mockResolvedValue(['Ubuntu'])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(true) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(true) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities()

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell: () => {},
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: Git Bash')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).not.toBeNull()
  })

  it('uses the paired host platform to show Windows shell rows in a Mac browser', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(true),
          listDistros: vi.fn().mockResolvedValue(['Ubuntu'])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })
    appStoreSnapshot.activeRuntimeEnvironmentId = 'web-env-1'
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities({
      force: true,
      ownerKey: 'runtime:web-env-1'
    })

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell: () => {},
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')
    ).not.toBeNull()
    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: CMD Prompt')
    ).not.toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).not.toBeNull()
  })

  it('uses the active remote host platform to show Windows shell rows in a Mac desktop client', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(true),
          listDistros: vi.fn().mockResolvedValue(['Ubuntu'])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })
    appStoreSnapshot.activeRuntimeEnvironmentId = 'desktop-env-1'
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities({
      force: true,
      ownerKey: 'runtime:desktop-env-1'
    })

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell: () => {},
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')
    ).not.toBeNull()
    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: CMD Prompt')
    ).not.toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).not.toBeNull()
  })

  it('shows the Git Bash terminal row when shared Windows capabilities find bash.exe', async () => {
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(true) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities()

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    const onNewTerminalWithShell = vi.fn()
    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell,
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    const item = findDropdownMenuItemByText(expandNode(element), 'New Terminal: Git Bash')
    expect(item).not.toBeNull()

    const onSelect = item?.props.onSelect as (() => void) | undefined
    onSelect?.()

    expect(onNewTerminalWithShell).toHaveBeenCalledWith('git-bash')
  })

  it('hides local Windows shell rows for SSH worktrees', async () => {
    appStoreSnapshot.repos = [{ id: 'repo-1', connectionId: 'ssh-1' }]
    appStoreSnapshot.worktreesByRepo = {
      'repo-1': [{ id: 'wt-ssh', repoId: 'repo-1' }]
    }
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(true),
          listDistros: vi.fn().mockResolvedValue(['Ubuntu'])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(true) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(true) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities()

    const tabBarModule = await import('./TabBar')
    const candidate = tabBarModule.default ?? tabBarModule
    const TabBar =
      typeof candidate === 'function'
        ? candidate
        : typeof (candidate as { type?: unknown }).type === 'function'
          ? (candidate as { type: (props: Record<string, unknown>) => unknown }).type
          : null
    expect(TabBar).not.toBeNull()

    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-ssh',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell: vi.fn(),
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: Git Bash')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal')).not.toBeNull()
  })
})
