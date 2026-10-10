import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  type FloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'
import {
  consumeFloatingTerminalOpenMaximizedIntent,
  requestFloatingTerminalOpenMaximized
} from '@/lib/floating-terminal'
import { FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY } from './floating-terminal-panel-view-state'
import {
  setupFloatingTerminalPanelTest,
  mocks,
  hookRuntime
} from './floating-terminal-panel-test-harness'
import {
  findByProp,
  findByTypeName,
  getMockedLocalStorage,
  getPanelClassName,
  getPanelStyleBounds,
  renderPanel,
  runEffects,
  setViewport,
  collectPropValues,
  flushAsyncWork,
  type ReactElementLike
} from './floating-terminal-panel-render-probe'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  makeTab,
  setFloatingTabs,
  storeBox,
  type FloatingPanelStoreState,
  makeFile,
  setFloatingEditorTabs
} from './floating-terminal-panel-test-fixtures'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import { ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT } from '@/components/editor/editor-autosave'

vi.mock('zustand/react/shallow', () => ({
  // Why: zustand resolves the real react (unmocked in node_modules); the memo wrapper is inert here.
  useShallow: (selector: unknown) => selector
}))
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

function requestedEditorCloses(): string[] {
  return vi
    .mocked(window.dispatchEvent)
    .mock.calls.flatMap(([event]) =>
      event.type === ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT && event instanceof CustomEvent
        ? [event.detail.fileId]
        : []
    )
}

describe('FloatingTerminalPanel close behavior', () => {
  beforeEach(setupFloatingTerminalPanelTest)

  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('starts from persisted user bounds when storage has valid geometry', async () => {
    const savedBounds = { left: 120, top: 96, width: 760, height: 420 }
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )

    const element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual(savedBounds)
  })

  it('layers above root notification cards but below the modal layer', async () => {
    const element = await renderPanel(true)

    expect(getPanelClassName(element)).toContain('z-[45]')
  })

  it('falls back to default bounds when persisted geometry is malformed', async () => {
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY
        ? '{"left":120,"top":96,"width":760}'
        : null
    )

    const element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual(getDefaultFloatingTerminalBounds())
  })

  it('defers saved user-bound clamping while the startup viewport is zero-sized', async () => {
    const savedBounds = { left: 900, top: 500, width: 760, height: 420 }
    setViewport(0, 0)
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )

    let element = await renderPanel(true)
    expect(getPanelStyleBounds(element)).toEqual(savedBounds)

    runEffects()
    element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual(savedBounds)
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()
  })

  it('re-anchors default bounds when the viewport becomes usable', async () => {
    setViewport(0, 0)
    await renderPanel(true)
    setViewport(1200, 800)

    runEffects()
    const element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual(getDefaultFloatingTerminalBounds())
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()
  })

  it('clamps saved user bounds into the current viewport without persisting the clamp', async () => {
    const savedBounds = { left: 2000, top: 1200, width: 1000, height: 700 }
    setViewport(800, 600)
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )
    const expectedBounds = clampFloatingTerminalBounds(savedBounds)

    let element = await renderPanel(true)
    expect(getPanelStyleBounds(element)).toEqual(expectedBounds)

    runEffects()
    element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual(expectedBounds)
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()
  })

  it('restores anchored saved bounds after a skinny viewport clamp', async () => {
    const savedBounds = {
      anchorX: 'right',
      anchorY: 'bottom',
      offsetX: 40,
      offsetY: 84,
      width: 920,
      height: 560
    }
    setViewport(520, 360)
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )

    let element = await renderPanel(true)
    expect(getPanelStyleBounds(element)).toEqual({
      left: 8,
      top: 36,
      width: 504,
      height: 316
    })

    setViewport(1200, 800)
    runEffects()
    element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual({
      left: 240,
      top: 156,
      width: 920,
      height: 560
    })
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()
  })

  it('does not persist a plain click on a default-positioned panel', async () => {
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')

    ;(panel.props.onMouseUp as (event: unknown) => void)({
      currentTarget: {
        getBoundingClientRect: () => ({ height: 560, width: 920 })
      }
    })

    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()
  })

  it('commits the last dragged bounds on pointer cancellation', async () => {
    const element = await renderPanel(true)
    const titlebar = findByProp(element, 'data-floating-terminal-shortcut-surface')
    const titlebarTarget = { closest: vi.fn().mockReturnValue(null) }
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    vi.stubGlobal('document', { activeElement: null })
    const startBounds = getDefaultFloatingTerminalBounds()
    const expectedBounds = clampFloatingTerminalBounds({
      ...startBounds,
      left: startBounds.left + 24,
      top: startBounds.top + 12
    })

    ;(titlebar.props.onPointerDown as (event: unknown) => void)({
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1,
      target: titlebarTarget
    })
    ;(titlebar.props.onPointerMove as (event: unknown) => void)({
      clientX: 34,
      clientY: 32,
      pointerId: 1
    })
    ;(titlebar.props.onPointerCancel as (event: unknown) => void)({ pointerId: 1 })

    expect(getMockedLocalStorage().setItem).toHaveBeenCalledWith(
      FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
      JSON.stringify({
        anchorX: 'right',
        anchorY: 'bottom',
        offsetX: 8,
        offsetY: 72,
        width: expectedBounds.width,
        height: expectedBounds.height
      })
    )
  })

  it('previews resize-handle movement without writing storage until commit', async () => {
    const element = await renderPanel(true)
    const resizeHandles = findByTypeName(element, 'FloatingTerminalResizeHandles')
    const startBounds = getDefaultFloatingTerminalBounds()
    const previewBounds = {
      ...startBounds,
      width: startBounds.width - 80,
      height: startBounds.height - 40
    }

    ;(resizeHandles.props.onPreviewBounds as (bounds: FloatingTerminalPanelBounds) => void)(
      previewBounds
    )
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()

    ;(resizeHandles.props.onCommitBounds as () => void)()

    expect(getMockedLocalStorage().setItem).toHaveBeenCalledWith(
      FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
      JSON.stringify({
        anchorX: 'right',
        anchorY: 'bottom',
        offsetX: 104,
        offsetY: 124,
        width: previewBounds.width,
        height: previewBounds.height
      })
    )
  })

  it('does not persist maximized bounds over the saved normal bounds', async () => {
    const savedBounds = { left: 120, top: 96, width: 760, height: 420 }
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )

    let element = await renderPanel(true)
    const controls = findByTypeName(element, 'FloatingTerminalWindowControls')
    ;(controls.props.onToggleMaximized as () => void)()

    element = await renderPanel(true)
    expect(getPanelStyleBounds(element)).toEqual(getMaximizedFloatingTerminalBounds())
    // Why key-scoped rather than "no writes": maximize now persists panel view state under
    // its own key. The invariant here is that the saved NORMAL bounds are never clobbered.
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalledWith(
      FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
      expect.anything()
    )

    const restoredControls = findByTypeName(element, 'FloatingTerminalWindowControls')
    ;(restoredControls.props.onToggleMaximized as () => void)()
    element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual(savedBounds)
    // Why key-scoped rather than "no writes": maximize now persists panel view state under
    // its own key. The invariant here is that the saved NORMAL bounds are never clobbered.
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalledWith(
      FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
      expect.anything()
    )
  })

  it('restores saved normal bounds after starting maximized', async () => {
    const savedBounds = { left: 120, top: 96, width: 760, height: 420 }
    getMockedLocalStorage().getItem.mockImplementation((key: string) => {
      if (key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY) {
        return JSON.stringify(savedBounds)
      }
      return key === FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY
        ? JSON.stringify({ open: true, maximized: true })
        : null
    })

    let element = await renderPanel(true)
    expect(getPanelStyleBounds(element)).toEqual(getMaximizedFloatingTerminalBounds())

    const controls = findByTypeName(element, 'FloatingTerminalWindowControls')
    ;(controls.props.onToggleMaximized as () => void)()
    element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual(savedBounds)
  })

  it('restores committed normal bounds after maximizing from a skinny clamp', async () => {
    const savedBounds = {
      anchorX: 'right',
      anchorY: 'bottom',
      offsetX: 40,
      offsetY: 84,
      width: 920,
      height: 560
    }
    setViewport(520, 360)
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )

    let element = await renderPanel(true)
    const controls = findByTypeName(element, 'FloatingTerminalWindowControls')
    ;(controls.props.onToggleMaximized as () => void)()

    element = await renderPanel(true)
    expect(getPanelStyleBounds(element)).toEqual(getMaximizedFloatingTerminalBounds())

    setViewport(1200, 800)
    const restoredControls = findByTypeName(element, 'FloatingTerminalWindowControls')
    ;(restoredControls.props.onToggleMaximized as () => void)()
    element = await renderPanel(true)

    expect(getPanelStyleBounds(element)).toEqual({
      left: 240,
      top: 156,
      width: 920,
      height: 560
    })
    // Why key-scoped rather than "no writes": maximize now persists panel view state under
    // its own key. The invariant here is that the saved NORMAL bounds are never clobbered.
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalledWith(
      FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
      expect.anything()
    )
  })

  it('opens maximized when the open-maximized intent is set, ignoring saved bounds', async () => {
    const savedBounds = { left: 120, top: 96, width: 760, height: 420 }
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )
    requestFloatingTerminalOpenMaximized()

    await renderPanel(true)
    runEffects()

    expect(getPanelStyleBounds(await renderPanel(true))).toEqual(
      getMaximizedFloatingTerminalBounds()
    )
    // Why: the intent is one-shot and must be consumed by the open transition.
    expect(consumeFloatingTerminalOpenMaximizedIntent()).toBe(false)
  })

  it('does not maximize on open when no intent is set', async () => {
    const savedBounds = { left: 120, top: 96, width: 760, height: 420 }
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY ? JSON.stringify(savedBounds) : null
    )

    const element = await renderPanel(true)
    runEffects()

    expect(getPanelStyleBounds(element)).toEqual(savedBounds)
  })
})

describe('FloatingTerminalPanel empty state', () => {
  beforeEach(setupFloatingTerminalPanelTest)

  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('does not bootstrap a terminal tab when the panel opens empty', async () => {
    await renderPanel(false)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(false)
    runEffects()
    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('requests the floating workspace tour only when the panel is open', async () => {
    const persisted = Promise.resolve()

    await renderPanel(false, vi.fn(), {
      wasPreviouslyInteracted: false,
      persisted,
      recordFeatureInteractionForTour: false
    })

    expect(mocks.useContextualTour).toHaveBeenLastCalledWith(
      'floating-workspace',
      false,
      'floating_workspace_visible',
      {
        recordFeatureInteraction: false,
        featureInteractionPersisted: persisted,
        wasFeaturePreviouslyInteracted: false
      }
    )

    await renderPanel(true, vi.fn(), {
      wasPreviouslyInteracted: true,
      persisted,
      recordFeatureInteractionForTour: false
    })

    expect(mocks.useContextualTour).toHaveBeenLastCalledWith(
      'floating-workspace',
      true,
      'floating_workspace_visible',
      {
        recordFeatureInteraction: false,
        featureInteractionPersisted: persisted,
        wasFeaturePreviouslyInteracted: true
      }
    )
  })

  it('records the floating workspace tour interaction when the open snapshot deferred persistence', async () => {
    await renderPanel(true, vi.fn(), {
      wasPreviouslyInteracted: false,
      recordFeatureInteractionForTour: true
    })

    expect(mocks.useContextualTour).toHaveBeenLastCalledWith(
      'floating-workspace',
      true,
      'floating_workspace_visible',
      {
        recordFeatureInteraction: true,
        featureInteractionPersisted: undefined,
        wasFeaturePreviouslyInteracted: false
      }
    )
  })

  it('targets the empty-state actions without co-mounting the surface fallback', async () => {
    const element = await renderPanel(true)
    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')
    const renderedEmptyState = (
      emptyState.type as (props: Record<string, unknown>) => ReactElementLike
    )(emptyState.props)

    expect(collectPropValues(element, 'data-contextual-tour-target')).not.toContain(
      'floating-workspace-surface'
    )
    expect(collectPropValues(renderedEmptyState, 'data-contextual-tour-target')).toEqual([
      'floating-workspace-new-terminal',
      'floating-workspace-new-markdown'
    ])
  })

  it('targets the non-empty panel surface when the empty-state actions are absent', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderPanel(true)

    expect(() => findByTypeName(element, 'FloatingTerminalEmptyState')).toThrow(
      'FloatingTerminalEmptyState not found'
    )
    expect(collectPropValues(element, 'data-contextual-tour-target')).toContain(
      'floating-workspace-surface'
    )
    expect(collectPropValues(element, 'data-contextual-tour-target')).not.toContain(
      'floating-workspace-new-terminal'
    )
    expect(collectPropValues(element, 'data-contextual-tour-target')).not.toContain(
      'floating-workspace-new-markdown'
    )
  })

  it('keeps the split surface mounted when its focused group has no tabs', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const state = storeBox.state as FloatingPanelStoreState
    state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID].push({
      id: 'empty-group',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabOrder: []
    })
    state.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] = 'empty-group'
    state.layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID] = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'floating-group' },
      second: { type: 'leaf', groupId: 'empty-group' }
    }

    const element = await renderPanel(true)

    expect(() => findByTypeName(element, 'FloatingTerminalEmptyState')).toThrow(
      'FloatingTerminalEmptyState not found'
    )
    expect(findByTypeName(element, 'TabGroupSplitNodeTree').props.focusedGroupId).toBe(
      'empty-group'
    )
  })

  it('minimizes the empty floating workspace from the empty state', async () => {
    const onOpenChange = vi.fn()
    const element = await renderPanel(true, onOpenChange)

    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')
    ;(emptyState.props.onClose as () => void)()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.closeFile).not.toHaveBeenCalled()
    expect(mocks.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('shows the empty state when only stale unified tabs remain', async () => {
    const state = storeBox.state as FloatingPanelStoreState
    const staleTab = makeTab({ id: 'stale-tab' })
    setFloatingTabs([staleTab])
    state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [] }
    state.activeTabIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: null }

    const element = await renderPanel(true)
    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')

    expect(emptyState).toBeTruthy()
  })
})

describe('FloatingTerminalPanel markdown editor', () => {
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
    // The editor renders inside the shared group tree; the panel's contract is the policy
    // it passes down (scratch markdown exposes no agent annotations).
    const tree = findByTypeName(element, 'TabGroupSplitNodeTree')

    expect(tree.props.markdownAnnotationsEnabled).toBe(false)
    expect(tree.props.isWorktreeActive).toBe(true)
  })

  it('marks the retained floating editor hidden when the panel is closed', async () => {
    setFloatingEditorTabs([makeFile({ id: 'notes' })])

    const element = await renderPanel(false)

    expect(findByTypeName(element, 'TabGroupSplitNodeTree').props.isWorktreeActive).toBe(false)
  })

  it('routes every dirty editor from close-all-files to the central save queue', async () => {
    setFloatingEditorTabs([
      makeFile({ id: 'file-a', isDirty: true }),
      makeFile({ id: 'file-b', isDirty: true })
    ])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseAllFiles as () => void)()

    expect(requestedEditorCloses()).toEqual(['file-a', 'file-b'])
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-a')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-b')
  })

  it('routes close-others and close-to-right through the central save queue', async () => {
    setFloatingEditorTabs([
      makeFile({ id: 'file-a', isDirty: true }),
      makeFile({ id: 'file-b', isDirty: true }),
      makeFile({ id: 'file-c', isDirty: true })
    ])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseOthers as (tabId: string) => void)('tab-file-b')
    expect(requestedEditorCloses()).toEqual(['file-a', 'file-c'])

    vi.mocked(window.dispatchEvent).mockClear()
    mocks.closeFile.mockClear()
    hookRuntime.values = []
    const nextElement = await renderPanel(true)
    const nextTabBar = findByTypeName(nextElement, 'TabBar')
    ;(nextTabBar.props.onCloseToRight as (tabId: string) => void)('tab-file-a')
    expect(requestedEditorCloses()).toEqual(['file-b', 'file-c'])
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-c')
  })
})
