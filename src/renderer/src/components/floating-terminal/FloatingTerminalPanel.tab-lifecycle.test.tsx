import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/tab-types'
import {
  makeFile,
  makeTab,
  setFloatingSimulatorTab,
  setFloatingTabs,
  storeBox,
  type FloatingPanelStoreState
} from './floating-terminal-panel-test-fixtures'
import {
  mocks,
  parkingBox,
  setupFloatingTerminalPanelTest
} from './floating-terminal-panel-test-harness'
import {
  findAllByTypeName,
  findByTypeName,
  flushAsyncWork,
  renderPanel,
  runEffects
} from './floating-terminal-panel-render-probe'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const { createReactHookOverrides } = await import('./floating-terminal-panel-test-module-mocks')
  return { ...actual, ...createReactHookOverrides() }
})

vi.mock('@/store', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createAppStoreModule()
})

vi.mock('@/components/tab-bar/TabBar', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createTabBarModule()
})

vi.mock('@/components/terminal-pane/TerminalPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createTerminalPaneModule()
})

vi.mock('@/components/terminal-pane/use-terminal-tab-cold-parking', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createColdParkingModule()
})

vi.mock('@/components/terminal-pane/terminal-parked-tab-watchers', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createParkedTabWatchersModule()
})

vi.mock('@/components/terminal-pane/terminal-ime-input-context-refresh', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createImeInputContextRefreshModule()
})

vi.mock('@/components/terminal/terminal-tab-actions', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createTerminalTabActionsModule()
})

vi.mock('@/store/pinned-tab-close-guard', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createPinnedTabCloseGuardModule()
})

vi.mock('@/components/browser-pane/BrowserPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createBrowserPaneModule()
})

vi.mock('@/components/emulator-pane/EmulatorPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createEmulatorPaneModule()
})

vi.mock('@/components/editor/EditorPanel', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createEditorPanelModule()
})

vi.mock('@/components/ui/button', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createButtonModule()
})

vi.mock('@/components/contextual-tours/use-contextual-tour', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createContextualTourModule()
})

vi.mock('@/components/ui/dialog', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createDialogModule()
})

vi.mock('@/components/terminal/useTerminalSaveDialog', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createTerminalSaveDialogModule()
})

vi.mock('@/runtime/web-runtime-session', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createWebRuntimeSessionModule()
})

vi.mock('@/lib/connection-context', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createConnectionContextModule()
})

// Why inline and sync: this module is imported by the test file itself, so an async factory
// resolves too late and the panel ends up calling a second copy of the mock.
vi.mock('@/lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
}))

vi.mock('@/lib/ipc-error', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createIpcErrorModule()
})

vi.mock('sonner', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createSonnerModule()
})

vi.mock('@/lib/focus-terminal-tab-surface', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createFocusTerminalTabSurfaceModule()
})

vi.mock('@/lib/orchestration-setup-state', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createOrchestrationSetupStateModule()
})

vi.mock('./FloatingTerminalOrchestrationDialog', async () => {
  return (
    await import('./floating-terminal-panel-component-stubs')
  ).createOrchestrationDialogModule()
})

vi.mock('./FloatingTerminalResizeHandles', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createResizeHandlesModule()
})

vi.mock('./FloatingTerminalToggleButton', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createToggleButtonModule()
})

vi.mock('./FloatingTerminalWindowControls', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createWindowControlsModule()
})

vi.mock('@/components/ShortcutKeyCombo', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createShortcutKeyComboModule()
})

describe('FloatingTerminalPanel close behavior', () => {
  beforeEach(setupFloatingTerminalPanelTest)

  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('creates new floating terminal tabs without globally activating createTab', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onNewTerminalTab as () => void)()
    await flushAsyncWork()

    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'floating-group',
      undefined,
      { activate: false }
    )
    expect(mocks.activateTab).toHaveBeenCalledWith('created-tab')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('created-tab')
  })

  it('keeps floating browser create and duplicate local during active web runtime sessions', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    ;(storeBox.state as FloatingPanelStoreState).settings.activeRuntimeEnvironmentId = 'runtime-1'
    ;(storeBox.state as FloatingPanelStoreState).browserTabsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        {
          id: 'browser-1',
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          sessionProfileId: 'profile-1',
          sessionPartition: 'persist:orca-browser-session-profile-1',
          createdAt: 1
        }
      ]
    }
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.createWebRuntimeSessionBrowserTab.mockResolvedValue(true)

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onNewBrowserTab as () => void)()
    ;(tabBar.props.onDuplicateBrowserTab as (browserTabId: string) => void)('browser-1')

    expect(mocks.createWebRuntimeSessionBrowserTab).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).toHaveBeenNthCalledWith(
      1,
      FLOATING_TERMINAL_WORKTREE_ID,
      'about:blank',
      {
        title: 'New Browser Tab',
        focusAddressBar: true,
        targetGroupId: 'floating-group',
        browserRuntimeEnvironmentId: null
      }
    )
    expect(mocks.createBrowserTab).toHaveBeenNthCalledWith(
      2,
      FLOATING_TERMINAL_WORKTREE_ID,
      'https://example.com',
      {
        title: 'Example',
        sessionProfileId: 'profile-1',
        sessionPartition: 'persist:orca-browser-session-profile-1',
        targetGroupId: 'floating-group',
        browserRuntimeEnvironmentId: null
      }
    )
  })

  it('hides the active terminal pane from the renderer while the panel is closed', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    // Why: the closed panel stays mounted but CSS-hidden; gating isVisible on
    // `open` routes the terminal through the standard hidden-terminal WebGL
    // suspend/resume path so no live glyph atlas can corrupt while hidden.
    await renderPanel(false)
    runEffects()
    await Promise.resolve()
    const closedElement = await renderPanel(false)
    const closedPane = findByTypeName(closedElement, 'TerminalPane')
    expect(closedPane.props.isActive).toBe(true)
    expect(closedPane.props.isVisible).toBe(false)

    const openElement = await renderPanel(true)
    const openPane = findByTypeName(openElement, 'TerminalPane')
    expect(openPane.props.isVisible).toBe(true)
  })

  it('does not mount floating terminal panes selected for cold parking', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })])
    parkingBox.parkedTabIds = new Set(['tab-2'])

    await renderPanel(true)
    runEffects()
    await Promise.resolve()
    const element = await renderPanel(true)

    expect(findAllByTypeName(element, 'TerminalPane').map((pane) => pane.props.tabId)).toEqual([
      'tab-1'
    ])
  })

  it('keeps the panel open when the explicit close action removes the last tab', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderPanel(true, onOpenChange)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')

    // Terminals route through closeTerminalTab (its own pin guard + F9 force-reenter), not the raw store close.
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
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

    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-2',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )
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

    ;(terminalPane.props.onPtyExit as (ptyId: string) => void)('pty-1')
    expect(mocks.shouldDeferParkedPtyExitTabClose).toHaveBeenCalledWith('tab-1', 'pty-1')
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith('tab-1', {
      lifecyclePtyId: 'pty-1',
      reason: 'pty-exit'
    })
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()

    mocks.closeTerminalTab.mockClear()
    ;(terminalPane.props.onCloseTab as () => void)()
    // Explicit pane close routes through the confirmed-close authority, not a raw pty-exit prune.
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('preserves split siblings when a parked PTY exits during reveal', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    mocks.shouldDeferParkedPtyExitTabClose.mockReturnValueOnce(true)

    await renderPanel(true)
    runEffects()
    await Promise.resolve()
    const element = await renderPanel(true)
    const terminalPane = findByTypeName(element, 'TerminalPane')

    ;(terminalPane.props.onPtyExit as (ptyId: string) => void)('split-pty')

    expect(mocks.shouldDeferParkedPtyExitTabClose).toHaveBeenCalledWith('tab-1', 'split-pty')
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('renders and closes simulator tabs in the floating workspace', async () => {
    const tab = setFloatingSimulatorTab()

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    const emulatorPane = findByTypeName(element, 'EmulatorPane')
    ;(tabBar.props.onCloseFile as (tabId: string) => void)(tab.id)

    expect(tabBar.props.activeTabType).toBe('simulator')
    expect(tabBar.props.activeSimulatorTabId).toBe(tab.id)
    expect(emulatorPane.props.tab).toBe(tab)
    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith(tab.id)
    expect(mocks.closeFile).not.toHaveBeenCalledWith(tab.id)
  })

  it('keeps simulator tabs open when closing all files', async () => {
    const state = storeBox.state as FloatingPanelStoreState
    const groupId = 'floating-group'
    const file = makeFile({ id: 'file-a' })
    const editorTab: Tab = {
      id: 'tab-file-a',
      entityId: file.id,
      groupId,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      contentType: 'editor',
      label: file.relativePath,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const simulatorTab: Tab = {
      id: 'simulator-tab',
      entityId: 'simulator-tab',
      groupId,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      contentType: 'simulator',
      label: 'Mobile Emulator',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 1
    }
    state.openFiles = [file]
    state.unifiedTabsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [editorTab, simulatorTab]
    }
    state.groupsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        {
          id: groupId,
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          activeTabId: editorTab.id,
          tabOrder: [editorTab.id, simulatorTab.id],
          recentTabIds: [editorTab.id, simulatorTab.id]
        }
      ]
    }
    state.activeGroupIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
    state.tabBarOrderByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [editorTab.id, simulatorTab.id]
    }

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseAllFiles as () => void)()

    expect(mocks.closeFile).toHaveBeenCalledWith(file.id)
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalledWith(simulatorTab.id)
  })

  it('keeps floating terminal create and close local during active web runtime sessions', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    ;(storeBox.state as FloatingPanelStoreState).settings.activeRuntimeEnvironmentId = 'runtime-1'
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue(true)

    const element = await renderPanel(true, onOpenChange)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onNewTerminalTab as () => void)()
    await flushAsyncWork()

    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'floating-group',
      undefined,
      { activate: false }
    )
    expect(mocks.activateTab).toHaveBeenCalledWith('created-tab')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('created-tab')

    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')
    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )
    expect(onOpenChange).not.toHaveBeenCalled()
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
    expect(mocks.closeTab).toHaveBeenCalledWith('new-left', { reason: 'cleanup' })
    expect(mocks.closeTab).toHaveBeenCalledWith('new-right', { reason: 'cleanup' })
    expect(mocks.closeTab).not.toHaveBeenCalledWith('old-left')

    mocks.closeTab.mockClear()
    ;(tabBar.props.onCloseToRight as (tabId: string) => void)('new-left')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-keep', { reason: 'cleanup' })
    expect(mocks.closeTab).toHaveBeenCalledWith('new-right', { reason: 'cleanup' })
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
    ;(storeBox.state as FloatingPanelStoreState).groupsByWorktree[
      FLOATING_TERMINAL_WORKTREE_ID
    ][0].tabOrder = ['tab-c', 'tab-a', 'tab-b']

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseToRight as (tabId: string) => void)('tab-c')

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-a', { reason: 'cleanup' })
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-b', { reason: 'cleanup' })
    expect(mocks.closeTab).not.toHaveBeenCalledWith('tab-c')
  })
})
