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

  it('shows the Windows shell rows for an SSH Windows host', async () => {
    appStoreSnapshot.repos = [{ id: 'repo-1', connectionId: 'ssh-1' }]
    appStoreSnapshot.sshConnectionStates = new Map([['ssh-1', { remotePlatform: 'win32' }]])
    appStoreSnapshot.worktreesByRepo = {
      'repo-1': [{ id: 'wt-ssh', repoId: 'repo-1' }]
    }
    const detectRemoteWindowsTerminalCapabilities = vi.fn().mockResolvedValue({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities({
      ownerKey: 'ssh:ssh-1',
      sshConnectionId: 'ssh-1'
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

    const onNewTerminalWithShell = vi.fn()
    const element = TabBar!({
      tabs: [],
      activeTabId: null,
      worktreeId: 'wt-ssh',
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

    const powerShellItem = findDropdownMenuItemByText(
      expandNode(element),
      'New Terminal: PowerShell'
    )
    expect(powerShellItem).not.toBeNull()
    expect(
      findDropdownMenuItemByText(expandNode(element), 'New Terminal: CMD Prompt')
    ).not.toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: Git Bash')).not.toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).not.toBeNull()

    const onSelect = powerShellItem?.props.onSelect as (() => void) | undefined
    onSelect?.()
    expect(onNewTerminalWithShell).toHaveBeenCalledWith('pwsh.exe')
  })

  it('keeps SSH Linux hosts on the generic new-terminal entry', async () => {
    appStoreSnapshot.repos = [{ id: 'repo-1', connectionId: 'ssh-1' }]
    appStoreSnapshot.sshConnectionStates = new Map([['ssh-1', { remotePlatform: 'linux' }]])
    appStoreSnapshot.worktreesByRepo = {
      'repo-1': [{ id: 'wt-ssh', repoId: 'repo-1' }]
    }
    const detectRemoteWindowsTerminalCapabilities = vi.fn().mockResolvedValue({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: 'linux'
    })
    vi.stubGlobal('window', {
      api: {
        preflight: {
          detectRemoteWindowsTerminalCapabilities
        }
      }
    })
    const capabilities = await import('@/lib/windows-terminal-capabilities')
    await capabilities.loadWindowsTerminalCapabilities({
      ownerKey: 'ssh:ssh-1',
      sshConnectionId: 'ssh-1'
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
      worktreeId: 'wt-ssh',
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
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: Git Bash')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal: WSL')).toBeNull()
    expect(findDropdownMenuItemByText(expandNode(element), 'New Terminal')).not.toBeNull()
  })
})
