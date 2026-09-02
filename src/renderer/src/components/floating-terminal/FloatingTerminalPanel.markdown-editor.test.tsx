import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import {
  makeFile,
  makeTab,
  setFloatingEditorTabs,
  setFloatingTabs
} from './floating-terminal-panel-test-fixtures'
import {
  hookRuntime,
  mocks,
  saveDialogBox,
  setupFloatingTerminalPanelTest
} from './floating-terminal-panel-test-harness'
import {
  findByProp,
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
  it('creates floating markdown files in local filesystem mode', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    vi.mocked(createUntitledMarkdownFileWithTemplateSelection).mockResolvedValue({
      filePath: '/tmp/orca/floating-notes/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    let element = await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onNewFileTab as () => void)()
    await flushAsyncWork()

    expect(createUntitledMarkdownFileWithTemplateSelection).toHaveBeenCalledWith(
      '/tmp/orca/floating-notes',
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      { activeRuntimeEnvironmentId: null }
    )
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/orca/floating-notes/untitled.md' }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })

  it('opens existing markdown documents through the floating picker', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    mocks.pickFloatingMarkdownDocument.mockResolvedValue({
      filePath: '/tmp/orca/notes.md',
      relativePath: 'notes.md',
      basename: 'notes.md',
      name: 'notes'
    })

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onOpenFileTab as () => void)()
    await flushAsyncWork()

    expect(mocks.pickFloatingMarkdownDocument).toHaveBeenCalledWith()
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/orca/notes.md',
        relativePath: 'notes.md',
        runtimeEnvironmentId: null,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })

  it('disables markdown annotations in floating editor tabs', async () => {
    setFloatingEditorTabs([makeFile({ id: 'notes' })])

    const element = await renderPanel(true)
    const editorPanel = findByProp(element, 'activeFileId')

    expect(editorPanel.props.markdownAnnotationsEnabled).toBe(false)
    expect(editorPanel.props.activeFileId).toBe('notes')
    expect(editorPanel.props.isVisible).toBe(true)
  })

  it('marks the retained floating editor hidden when the panel is closed', async () => {
    setFloatingEditorTabs([makeFile({ id: 'notes' })])

    const element = await renderPanel(false)
    const editorPanel = findByProp(element, 'activeFileId')

    expect(editorPanel.props.isVisible).toBe(false)
  })

  it('queues dirty editor closes from close-all-files instead of overwriting the dialog id', async () => {
    setFloatingEditorTabs([
      makeFile({ id: 'file-a', isDirty: true }),
      makeFile({ id: 'file-b', isDirty: true })
    ])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseAllFiles as () => void)()

    expect(saveDialogBox.fileId).toBe('file-a')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-a')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-b')
  })

  it('queues dirty editor closes from close-others and close-to-right one file at a time', async () => {
    setFloatingEditorTabs([
      makeFile({ id: 'file-a', isDirty: true }),
      makeFile({ id: 'file-b', isDirty: true }),
      makeFile({ id: 'file-c', isDirty: true })
    ])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseOthers as (tabId: string) => void)('tab-file-b')
    expect(saveDialogBox.fileId).toBe('file-a')

    saveDialogBox.fileId = null
    mocks.closeFile.mockClear()
    hookRuntime.values = []
    const nextElement = await renderPanel(true)
    const nextTabBar = findByTypeName(nextElement, 'TabBar')
    ;(nextTabBar.props.onCloseToRight as (tabId: string) => void)('tab-file-a')
    expect(saveDialogBox.fileId).toBe('file-b')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-c')
  })
})
