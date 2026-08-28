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
import { setupFloatingTerminalPanelTest } from './floating-terminal-panel-test-harness'
import {
  findByProp,
  findByTypeName,
  getMockedLocalStorage,
  getPanelClassName,
  getPanelStyleBounds,
  renderPanel,
  runEffects,
  setViewport
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
