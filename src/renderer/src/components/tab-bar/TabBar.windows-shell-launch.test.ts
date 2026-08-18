import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expandNode, findDropdownMenuItemByText } from './tab-bar-dropdown-menu-item-probe'
import {
  stubBrowserTab,
  stubDropdownMenu,
  stubEditorFileTab,
  stubEditorLabels,
  stubFocusTerminalTabSurface,
  stubHeadlessReact,
  stubQuickLaunchButton,
  stubShallowSelector,
  stubShellIcons,
  stubSortableContext,
  stubSortableTab,
  stubStatusDisplay,
  stubTabInsertion,
  stubTabStripDragScroll
} from './tab-bar-windows-shell-launch-render-stubs'
import {
  appStoreSnapshot,
  resetAppStoreSnapshot,
  useAppStoreExport
} from './tab-bar-windows-shell-launch-test-harness'

vi.mock('react', async () => await stubHeadlessReact())
vi.mock('zustand/react/shallow', () => stubShallowSelector())
vi.mock('lucide-react', async () => (await import('./lucide-icon-stub-fixture')).stubEveryIcon())
vi.mock('@dnd-kit/sortable', () => stubSortableContext())
vi.mock('./tab-strip-drag-scroll', () => stubTabStripDragScroll())
vi.mock('../../store', () => ({ useAppStore: useAppStoreExport }))
vi.mock('../right-sidebar/status-display', () => stubStatusDisplay())
vi.mock('../tab-group/tab-insertion', () => stubTabInsertion())
vi.mock('@/components/editor/editor-labels', () => stubEditorLabels())
vi.mock('./SortableTab', () => stubSortableTab())
vi.mock('./EditorFileTab', () => stubEditorFileTab())
vi.mock('./BrowserTab', () => stubBrowserTab())
vi.mock('./QuickLaunchButton', () => stubQuickLaunchButton())
vi.mock('./shell-icons', () => stubShellIcons())
vi.mock('@/lib/focus-terminal-tab-surface', () => stubFocusTerminalTabSurface())
vi.mock('@/components/ui/dropdown-menu', () => stubDropdownMenu())

describe('TabBar PowerShell launch wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    resetAppStoreSnapshot()
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
      onCloseToLeft: () => {},
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
      onCloseToLeft: () => {},
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
      onCloseToLeft: () => {},
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
      onCloseToLeft: () => {},
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
})
