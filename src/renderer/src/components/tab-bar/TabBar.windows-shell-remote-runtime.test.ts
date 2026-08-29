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
    appStoreSnapshot.worktreesByRepo = {
      fixture: [
        {
          id: 'wt-1',
          repoId: 'fixture',
          hostId: 'local',
          runtimeOwnerEnvironmentId: 'web-env-1'
        }
      ]
    }
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
    appStoreSnapshot.worktreesByRepo = {
      fixture: [
        {
          id: 'wt-1',
          repoId: 'fixture',
          hostId: 'local',
          runtimeOwnerEnvironmentId: 'desktop-env-1'
        }
      ]
    }
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
    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: CMD Prompt')
    ).not.toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).not.toBeNull()
  })

  it('hides local Windows shell rows for a non-Windows serve runtime', async () => {
    // Why: a Windows desktop client paired to a Linux `orca serve` runs its PTY on
    // the serve host. The local Windows shell choices (PowerShell/CMD/WSL) are
    // meaningless there; the plain "New Terminal" already opens the serve's default
    // shell. Sibling tests above assert that a win32 remote host still shows the
    // rows, so the LOCAL Windows-WSL project-runtime menu (hostPlatform 'win32')
    // is unaffected by this suppression.
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'linux' }) }
      }
    })
    appStoreSnapshot.activeRuntimeEnvironmentId = 'serve-env-1'
    appStoreSnapshot.worktreesByRepo = {
      fixture: [
        {
          id: 'wt-1',
          repoId: 'fixture',
          hostId: 'local',
          runtimeOwnerEnvironmentId: 'serve-env-1'
        }
      ]
    }
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities({
      force: true,
      ownerKey: 'runtime:serve-env-1'
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
      onCloseToLeft: () => {},
      onNewTerminalTab: () => {},
      onNewTerminalWithShell: vi.fn(),
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    })

    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: PowerShell')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: CMD Prompt')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal')).not.toBeNull()
  })
})
