import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import type { BrowserTab } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import { getMaximizedFloatingTerminalBounds } from './floating-terminal-panel-bounds'
import {
  makeTab,
  setFloatingTabs,
  storeBox,
  type FloatingPanelStoreState
} from './floating-terminal-panel-test-fixtures'
import { mocks, setupFloatingTerminalPanelTest } from './floating-terminal-panel-test-harness'
import {
  attachRef,
  bindFocusedFloatingPanelKeydown,
  findByProp,
  flushAsyncWork,
  getPanelStyleBounds,
  makeFocusedPanelKeyEvent,
  makeMacShortcutKeyEvent,
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
  it('routes titlebar Cmd+T to the floating workspace', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebarTarget = {
      closest: vi.fn().mockReturnValue({}),
      getAttribute: vi.fn().mockReturnValue(null)
    }
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    const preventDefault = vi.fn()

    ;(panel.props.onKeyDownCapture as (event: unknown) => void)(
      makeMacShortcutKeyEvent({
        key: 't',
        preventDefault,
        target: titlebarTarget
      })
    )
    await flushAsyncWork()

    expect(preventDefault).toHaveBeenCalledWith()
    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'floating-group',
      undefined,
      { activate: false }
    )
    expect(mocks.activateTab).toHaveBeenCalledWith('created-tab')
  })

  it('routes titlebar Cmd+Shift+O to the floating markdown picker', async () => {
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebarTarget = {
      closest: vi.fn().mockReturnValue({}),
      getAttribute: vi.fn().mockReturnValue(null)
    }
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    const preventDefault = vi.fn()

    ;(panel.props.onKeyDownCapture as (event: unknown) => void)(
      makeMacShortcutKeyEvent({
        key: 'o',
        preventDefault,
        shiftKey: true,
        target: titlebarTarget
      })
    )
    await flushAsyncWork()

    expect(preventDefault).toHaveBeenCalledWith()
    expect(mocks.pickFloatingMarkdownDocument).toHaveBeenCalledWith()
  })

  it('routes focused floating terminal double-tap shortcuts to the floating workspace', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    ;(storeBox.state as FloatingPanelStoreState).keybindings = {
      'tab.newTerminal': ['DoubleTap+Shift']
    }
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const target = {
      classList: { contains: vi.fn((token: string) => token === 'xterm-helper-textarea') },
      closest: vi.fn((selector: string) =>
        selector === '[data-floating-terminal-panel]' ? panelElement : null
      )
    }
    Object.setPrototypeOf(target, HTMLElement.prototype)
    attachRef(panel.props.ref, panelElement)
    vi.stubGlobal('document', {
      activeElement: target,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    runEffects()
    const keydownListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'keydown')?.[1] as
      | ((event: unknown) => void)
      | undefined
    const keyupListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'keyup')?.[1] as ((event: unknown) => void) | undefined
    if (!keydownListener || !keyupListener) {
      throw new Error('keyboard listeners not registered')
    }

    const modifierEvent = {
      altKey: false,
      code: 'ShiftLeft',
      ctrlKey: false,
      defaultPrevented: false,
      key: 'Shift',
      metaKey: false,
      repeat: false,
      shiftKey: true,
      target
    }
    const firstPreventDefault = vi.fn()
    keydownListener({ ...modifierEvent, preventDefault: firstPreventDefault })
    keyupListener({ ...modifierEvent })
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopImmediatePropagation = vi.fn()
    keydownListener({
      ...modifierEvent,
      preventDefault,
      stopImmediatePropagation,
      stopPropagation
    })
    await flushAsyncWork()

    expect(firstPreventDefault).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledWith()
    expect(stopPropagation).toHaveBeenCalledWith()
    expect(stopImmediatePropagation).toHaveBeenCalledWith()
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'floating-group',
      undefined,
      { activate: false }
    )
    expect(mocks.activateTab).toHaveBeenCalledWith('created-tab')
  })

  it('resets focused floating terminal double-tap detection on window blur', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    ;(storeBox.state as FloatingPanelStoreState).keybindings = {
      'tab.newTerminal': ['DoubleTap+Shift']
    }
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const target = {
      classList: { contains: vi.fn((token: string) => token === 'xterm-helper-textarea') },
      closest: vi.fn((selector: string) =>
        selector === '[data-floating-terminal-panel]' ? panelElement : null
      )
    }
    Object.setPrototypeOf(target, HTMLElement.prototype)
    attachRef(panel.props.ref, panelElement)
    vi.stubGlobal('document', {
      activeElement: target,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    runEffects()
    const keydownListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'keydown')?.[1] as
      | ((event: unknown) => void)
      | undefined
    const keyupListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'keyup')?.[1] as ((event: unknown) => void) | undefined
    const blurListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'blur')?.[1] as (() => void) | undefined
    if (!keydownListener || !keyupListener || !blurListener) {
      throw new Error('keyboard listeners not registered')
    }

    const modifierEvent = {
      altKey: false,
      code: 'ShiftLeft',
      ctrlKey: false,
      defaultPrevented: false,
      key: 'Shift',
      metaKey: false,
      repeat: false,
      shiftKey: true,
      target
    }
    keydownListener({ ...modifierEvent, preventDefault: vi.fn() })
    keyupListener({ ...modifierEvent })
    blurListener()
    const preventDefault = vi.fn()
    keydownListener({
      ...modifierEvent,
      preventDefault,
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn()
    })
    await flushAsyncWork()

    expect(preventDefault).not.toHaveBeenCalled()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('routes focused floating tab switch shortcuts to the floating workspace', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    const target = {
      classList: { contains: vi.fn((token: string) => token === 'xterm-helper-textarea') },
      closest: vi.fn((selector: string) =>
        selector === '[data-floating-terminal-panel]' ? panelElement : null
      )
    }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    Object.setPrototypeOf(target, HTMLElement.prototype)
    attachRef(panel.props.ref, panelElement)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    runEffects()
    const keydownListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'keydown')?.[1] as
      | ((event: unknown) => void)
      | undefined
    if (!keydownListener) {
      throw new Error('keydown listener not registered')
    }
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopImmediatePropagation = vi.fn()

    keydownListener({
      altKey: false,
      code: 'BracketRight',
      ctrlKey: false,
      defaultPrevented: false,
      key: ']',
      metaKey: true,
      preventDefault,
      repeat: false,
      shiftKey: true,
      stopImmediatePropagation,
      stopPropagation,
      target
    })

    expect(preventDefault).toHaveBeenCalledWith()
    expect(stopPropagation).toHaveBeenCalledWith()
    expect(stopImmediatePropagation).toHaveBeenCalledWith()
    expect(mocks.activateTab).toHaveBeenCalledWith('tab-2')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('tab-2')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-2')
  })

  it('routes focused floating tab rename shortcuts to the active floating tab', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopImmediatePropagation = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        key: 'r',
        metaKey: true,
        preventDefault,
        stopImmediatePropagation,
        stopPropagation,
        target: panelElement
      })
    )

    expect(preventDefault).toHaveBeenCalledWith()
    expect(stopPropagation).toHaveBeenCalledWith()
    expect(stopImmediatePropagation).toHaveBeenCalledWith()
    expect(mocks.setRenamingTabId).toHaveBeenCalledWith('tab-1')
    expect(mocks.setTabCustomTitle).not.toHaveBeenCalled()
  })

  it('routes focused floating tab index shortcuts to the matching visible tab', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' }), makeTab({ id: 'tab-3' })])
    const element = await renderPanel(true)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopImmediatePropagation = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        code: 'Digit3',
        ctrlKey: true,
        key: '3',
        preventDefault,
        stopImmediatePropagation,
        stopPropagation,
        target: panelElement
      })
    )

    expect(preventDefault).toHaveBeenCalledWith()
    expect(stopPropagation).toHaveBeenCalledWith()
    expect(stopImmediatePropagation).toHaveBeenCalledWith()
    expect(mocks.activateTab).toHaveBeenCalledWith('tab-3')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('tab-3')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-3')
  })

  it('routes focused floating tab index shortcuts across mixed visible tab types', async () => {
    const state = storeBox.state as FloatingPanelStoreState
    const groupId = 'floating-group'
    const terminalTab = makeTab({ id: 'terminal-tab' })
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
    const browserTab: BrowserTab = {
      id: 'browser-tab',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      url: '',
      title: 'Browser',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 2
    }
    const browserUnifiedTab: Tab = {
      id: 'browser-unified-tab',
      entityId: browserTab.id,
      groupId,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      contentType: 'browser',
      label: 'Browser',
      customLabel: null,
      color: null,
      sortOrder: 2,
      createdAt: 2
    }
    const terminalUnifiedTab: Tab = {
      id: terminalTab.id,
      entityId: terminalTab.id,
      groupId,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      contentType: 'terminal',
      label: terminalTab.title,
      customLabel: terminalTab.customTitle,
      color: terminalTab.color,
      sortOrder: 0,
      createdAt: terminalTab.createdAt
    }
    state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [terminalTab] }
    state.browserTabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [browserTab] }
    state.unifiedTabsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [terminalUnifiedTab, simulatorTab, browserUnifiedTab]
    }
    state.groupsByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        {
          id: groupId,
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          activeTabId: terminalUnifiedTab.id,
          tabOrder: [terminalUnifiedTab.id, simulatorTab.id, browserUnifiedTab.id],
          recentTabIds: [terminalUnifiedTab.id, simulatorTab.id, browserUnifiedTab.id]
        }
      ]
    }
    state.activeGroupIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
    state.activeTabIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: terminalTab.id }
    state.tabBarOrderByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        terminalUnifiedTab.id,
        simulatorTab.id,
        browserUnifiedTab.id
      ]
    }
    const element = await renderPanel(true)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        code: 'Digit2',
        ctrlKey: true,
        key: '2',
        preventDefault,
        target: panelElement
      })
    )

    expect(preventDefault).toHaveBeenCalledWith()
    expect(mocks.activateTab).toHaveBeenCalledWith('simulator-tab')
  })

  // F4: an out-of-range index chord in app context must still be CONSUMED (never leak a raw key to
  // the shell once L1 yields it), and simply skip activation when no tab exists at that index.
  it('consumes but does not activate a focused floating tab index shortcut past the visible tab count', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })])
    const element = await renderPanel(true)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopImmediatePropagation = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        code: 'Digit5',
        ctrlKey: true,
        key: '5',
        preventDefault,
        stopImmediatePropagation,
        stopPropagation,
        target: panelElement
      })
    )

    expect(preventDefault).toHaveBeenCalledWith()
    expect(stopImmediatePropagation).toHaveBeenCalledWith()
    expect(mocks.activateTab).not.toHaveBeenCalled()
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
  })

  it('ignores focused floating tab rename shortcuts when no tab is active', async () => {
    const element = await renderPanel(true)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopImmediatePropagation = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        key: 'r',
        metaKey: true,
        preventDefault,
        stopImmediatePropagation,
        stopPropagation,
        target: panelElement
      })
    )

    expect(mocks.setRenamingTabId).not.toHaveBeenCalled()
  })

  it('leaves focused floating xterm tab index shortcuts to terminal-first terminals', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })])
    ;(storeBox.state as FloatingPanelStoreState).settings = {
      ...(storeBox.state as FloatingPanelStoreState).settings,
      terminalShortcutPolicy: 'terminal-first'
    }
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const target = {
      classList: { contains: vi.fn((token: string) => token === 'xterm-helper-textarea') },
      closest: vi.fn((selector: string) =>
        selector === '[data-floating-terminal-panel]' ? panelElement : null
      )
    }
    Object.setPrototypeOf(target, HTMLElement.prototype)
    attachRef(panel.props.ref, panelElement)
    vi.stubGlobal('document', {
      activeElement: target,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    runEffects()
    const keydownListener = vi.mocked(window.addEventListener).mock.calls.find(([type]) => {
      return type === 'keydown'
    })?.[1] as ((event: unknown) => void) | undefined
    if (!keydownListener) {
      throw new Error('keydown listener not registered')
    }
    const ctrlPreventDefault = vi.fn()
    const ctrlStopPropagation = vi.fn()
    const ctrlStopImmediatePropagation = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        code: 'Digit2',
        ctrlKey: true,
        key: '2',
        preventDefault: ctrlPreventDefault,
        stopImmediatePropagation: ctrlStopImmediatePropagation,
        stopPropagation: ctrlStopPropagation,
        target
      })
    )

    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const altPreventDefault = vi.fn()
    const altStopPropagation = vi.fn()
    const altStopImmediatePropagation = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        altKey: true,
        code: 'Digit2',
        key: '2',
        preventDefault: altPreventDefault,
        stopImmediatePropagation: altStopImmediatePropagation,
        stopPropagation: altStopPropagation,
        target
      })
    )

    expect(ctrlPreventDefault).not.toHaveBeenCalled()
    expect(ctrlStopPropagation).not.toHaveBeenCalled()
    expect(ctrlStopImmediatePropagation).not.toHaveBeenCalled()
    expect(altPreventDefault).not.toHaveBeenCalled()
    expect(altStopPropagation).not.toHaveBeenCalled()
    expect(altStopImmediatePropagation).not.toHaveBeenCalled()
    expect(mocks.activateTab).not.toHaveBeenCalled()
  })

  it('routes focused floating workspace maximize shortcuts like the titlebar control', async () => {
    ;(storeBox.state as FloatingPanelStoreState).keybindings = {
      'floatingWorkspace.maximize': ['Ctrl+Alt+M']
    } as unknown as KeybindingOverrides
    const element = await renderPanel(true)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        altKey: true,
        ctrlKey: true,
        key: 'm',
        preventDefault,
        target: panelElement
      })
    )

    expect(preventDefault).toHaveBeenCalledWith()
    expect(getPanelStyleBounds(await renderPanel(true))).toEqual(
      getMaximizedFloatingTerminalBounds()
    )
  })

  it('routes focused floating workspace minimize shortcuts to close the panel', async () => {
    ;(storeBox.state as FloatingPanelStoreState).keybindings = {
      'floatingWorkspace.minimize': ['Ctrl+Alt+N']
    } as unknown as KeybindingOverrides
    const onOpenChange = vi.fn()
    const element = await renderPanel(true, onOpenChange)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        altKey: true,
        ctrlKey: true,
        key: 'n',
        preventDefault,
        target: panelElement
      })
    )

    expect(preventDefault).toHaveBeenCalledWith()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('routes focused floating workspace maximize shortcuts from a custom binding on Linux', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    ;(storeBox.state as FloatingPanelStoreState).keybindings = {
      'floatingWorkspace.maximize': ['Ctrl+Alt+M']
    } as unknown as KeybindingOverrides
    const element = await renderPanel(true)
    const { keydownListener, panelElement } = bindFocusedFloatingPanelKeydown(element)
    const preventDefault = vi.fn()

    keydownListener(
      makeFocusedPanelKeyEvent({
        altKey: true,
        ctrlKey: true,
        key: 'm',
        preventDefault,
        target: panelElement
      })
    )

    expect(preventDefault).toHaveBeenCalledWith()
    expect(getPanelStyleBounds(await renderPanel(true))).toEqual(
      getMaximizedFloatingTerminalBounds()
    )
  })

  it('minimizes the empty floating workspace on Cmd+W after landing focus', async () => {
    const onOpenChange = vi.fn()
    const element = await renderPanel(true, onOpenChange)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const emptyStateTarget = {
      closest: vi.fn().mockReturnValue({}),
      getAttribute: vi.fn().mockReturnValue(null)
    }
    Object.setPrototypeOf(emptyStateTarget, HTMLElement.prototype)

    ;(panel.props.onKeyDownCapture as (event: unknown) => void)(
      makeMacShortcutKeyEvent({
        key: 'w',
        preventDefault: vi.fn(),
        target: emptyStateTarget
      })
    )

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })
})
