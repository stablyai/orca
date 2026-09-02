import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import {
  makeFile,
  makeTab,
  setFloatingEditorTabs,
  setFloatingTabs
} from './floating-terminal-panel-test-fixtures'
import {
  mocks,
  saveDialogBox,
  setupFloatingTerminalPanelTest
} from './floating-terminal-panel-test-harness'
import {
  attachRef,
  findByProp,
  findByTypeName,
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
  it('refreshes terminal native input focus when the floating panel opens', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    await renderPanel(true)
    runEffects()

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith(
      'tab-1',
      null,
      expect.objectContaining({
        onImeRefocusSkipped: expect.any(Function),
        refreshImeContext: true
      })
    )
    mocks.setFloatingFocus.mockClear()
    mocks.focusTerminalTabSurface.mock.calls[0]?.[2].onImeRefocusSkipped()
    // No refocus target: both bits false (atomic payload, F7).
    expect(mocks.setFloatingFocus).toHaveBeenCalledWith({
      panelFocused: false,
      terminalFocused: false
    })

    const newerFloatingInput = {
      classList: { contains: (token: string) => token === 'xterm-helper-textarea' },
      closest: vi.fn().mockReturnValue({})
    }
    Object.setPrototypeOf(newerFloatingInput, HTMLElement.prototype)
    mocks.focusTerminalTabSurface.mock.calls[0]?.[2].onImeRefocusSkipped(newerFloatingInput)
    // Relatched onto the floating xterm: panel ⊇ terminal, both true.
    expect(mocks.setFloatingFocus).toHaveBeenLastCalledWith({
      panelFocused: true,
      terminalFocused: true
    })
  })

  it('preserves and reclaims terminal input ownership across window blur', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const terminalInput = {
      blur: vi.fn(),
      classList: { contains: vi.fn((token: string) => token === 'xterm-helper-textarea') },
      closest: vi.fn((selector: string) => {
        if (selector === '[data-floating-terminal-panel]') {
          return panelElement
        }
        return selector === '[data-leaf-id]'
          ? {
              getAttribute: (attribute: string) => (attribute === 'data-leaf-id' ? 'leaf-1' : null)
            }
          : null
      }),
      isConnected: true
    }
    Object.setPrototypeOf(panelElement, HTMLElement.prototype)
    Object.setPrototypeOf(terminalInput, HTMLElement.prototype)
    attachRef(panel.props.ref, panelElement)
    mocks.isTerminalImeInputContextRefreshing.mockReturnValueOnce(true)
    const onBlurCapture = panel.props.onBlurCapture as (event: unknown) => void
    onBlurCapture({
      relatedTarget: null,
      target: terminalInput
    })
    expect(mocks.setFloatingFocus).not.toHaveBeenCalled()
    const documentState = {
      activeElement: terminalInput as unknown as HTMLElement | null,
      addEventListener: vi.fn(),
      body: {} as HTMLElement,
      removeEventListener: vi.fn()
    }
    vi.stubGlobal('document', documentState)
    runEffects()
    const blurListener = vi
      .mocked(window.addEventListener)
      .mock.calls.findLast(([type]) => type === 'blur')?.[1] as (() => void) | undefined
    const focusListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'focus')?.[1] as (() => void) | undefined
    if (!blurListener || !focusListener) {
      throw new Error('floating terminal window focus listeners not registered')
    }

    blurListener()
    expect(terminalInput.blur).not.toHaveBeenCalled()

    focusListener()
    expect(mocks.setFloatingFocus).toHaveBeenLastCalledWith({
      panelFocused: true,
      terminalFocused: true
    })

    documentState.activeElement = terminalInput as unknown as HTMLElement
    blurListener()
    documentState.activeElement = documentState.body
    mocks.focusTerminalTabSurface.mockClear()
    focusListener()
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()

    documentState.activeElement = terminalInput as unknown as HTMLElement
    blurListener()
    terminalInput.isConnected = false
    documentState.activeElement = documentState.body
    focusListener()
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith(
      'tab-1',
      'leaf-1',
      expect.objectContaining({
        onlyIfFocusUnclaimed: true,
        onImeRefocusSkipped: expect.any(Function),
        refreshImeContext: true
      })
    )
  })

  it('focuses the empty floating workspace when opened for immediate shortcuts', async () => {
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { focus: vi.fn() }
    attachRef(panel.props.ref, panelElement)

    runEffects()

    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('does not crash if the preload focus bridge is stale during dev reload', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      api: {
        app: {
          getFloatingMarkdownDirectory: mocks.getFloatingMarkdownDirectory,
          getFloatingTerminalCwd: mocks.getFloatingTerminalCwd,
          pickFloatingMarkdownDocument: mocks.pickFloatingMarkdownDocument
        },
        browser: { notifyActiveTabChanged: vi.fn() },
        cli: { getInstallStatus: mocks.getInstallStatus },
        ui: {}
      },
      innerWidth: 1200,
      removeEventListener: vi.fn()
    })

    await renderPanel(false)

    expect(() => runEffects()).not.toThrow()
  })

  // F3 (a)/(b): a panel-owned close that empties the panel reclaims keyboard focus for the next
  // Cmd/Ctrl+T. The emptying close arms the one-shot intent (via closeTerminalTab's onClosed); the
  // count→0 effect consumes it on the now-empty re-render and focuses the panel root.
  it('reclaims panel keyboard focus after a focused last-pane close empties the panel', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    // A second render pass is needed before the active terminal pane mounts.
    await renderPanel(true)
    runEffects()
    await Promise.resolve()
    await renderPanel(true)
    runEffects()
    await Promise.resolve()
    const element = await renderPanel(true)
    attachRef(findByProp(element, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    // The last-pane close authority (L3 → onCloseTab) closes the tab while the panel owns focus.
    const terminalPane = findByTypeName(element, 'TerminalPane')
    ;(terminalPane.props.onCloseTab as () => void)()
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )

    // Panel is now empty: the count→0 effect consumes the armed intent and reclaims focus.
    setFloatingTabs([])
    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()
    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('cancels the pending reclaim frame when the panel root unmounts before it runs', async () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    vi.mocked(window.requestAnimationFrame).mockReturnValue(42)
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    // A second render pass is needed before the active terminal pane mounts.
    await renderPanel(true)
    runEffects()
    await Promise.resolve()
    const element = await renderPanel(true)
    attachRef(findByProp(element, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    const terminalPane = findByTypeName(element, 'TerminalPane')
    ;(terminalPane.props.onCloseTab as () => void)()

    // Emptying schedules the reclaim frame (id 42, callback not yet run); unmounting cancels it.
    setFloatingTabs([])
    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, null)

    // The reclaim frame (42) is canceled on unmount so its deferred focus never runs. (The
    // synchronous empty-panel open-focus effect is orthogonal and not scheduled through this frame.)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
  })

  // F3 (g): a close that leaves another tab does not empty the panel, so no intent is armed and
  // the surviving tab keeps focus instead of the panel root stealing it.
  it('does not arm a reclaim when a focused close leaves another floating tab', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })])
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    const element = await renderPanel(true)
    attachRef(findByProp(element, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-2')

    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-2',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )
    expect(consumeFloatingPanelReclaimIntent()).toBe(false)
    expect(panelElement.focus).not.toHaveBeenCalled()
  })

  // F3 arm-timing: arming is gated on closeTerminalTab's onClosed (the *actual* close), not on
  // close-initiation. A pinned/deferred close whose confirm is pending or cancelled never fires
  // onClosed, so an emptying, panel-owned close must still leave the intent unarmed — otherwise a
  // later empty-panel mount would reclaim focus for a close that never happened.
  it('does not arm a reclaim when an emptying close is deferred and onClosed never fires', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    // Model closeTerminalTab deferring to its pin-confirm dialog (or the user cancelling): the close
    // does not complete this tick, so the onClosed arming callback is never invoked.
    mocks.closeTerminalTab.mockImplementationOnce(() => {})
    const element = await renderPanel(true)
    attachRef(findByProp(element, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')

    // The panel owned focus and this close would empty it, yet arming rides on the real close via
    // onClosed — which never fired — so no intent is armed and nothing can reclaim later.
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )
    expect(consumeFloatingPanelReclaimIntent()).toBe(false)
  })

  // A dirty editor's close is deferred to the save dialog, so its arm check must survive the queue
  // and fire when the file actually leaves the panel — otherwise this one content type would empty
  // the panel with no intent armed and the next Cmd/Ctrl+T would miss the floating panel.
  it('reclaims panel keyboard focus after a deferred dirty-editor close empties the panel', async () => {
    setFloatingEditorTabs([makeFile({ id: 'file-a', isDirty: true })])
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    const element = await renderPanel(true)
    attachRef(findByProp(element, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-file-a')

    // The close is parked on the save dialog: nothing closed yet, so nothing reclaims focus yet.
    expect(saveDialogBox.fileId).toBe('file-a')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-a')
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()

    // The dialog resolves (save or discard) and the file leaves the panel: the parked arm runs on
    // the now-empty count and the count→0 effect consumes it. The deferred reclaim frame is the
    // signal here — the empty panel's own open-focus effect focuses synchronously, without a frame.
    saveDialogBox.fileId = null
    setFloatingEditorTabs([])
    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    expect(window.requestAnimationFrame).toHaveBeenCalled()
    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('drops the deferred dirty-editor arm when the save dialog is cancelled', async () => {
    setFloatingEditorTabs([makeFile({ id: 'file-a', isDirty: true })])
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    const element = await renderPanel(true)
    attachRef(findByProp(element, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-file-a')
    ;(findByTypeName(element, 'Dialog').props.onOpenChange as (open: boolean) => void)(false)

    // Cancel keeps the file open; a later close of that file (from some other path) must not
    // resurrect this cancelled close's arm.
    setFloatingEditorTabs([])
    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    // No intent armed and no deferred reclaim frame; the empty panel's synchronous open-focus
    // effect still runs, which is orthogonal to the reclaim.
    expect(consumeFloatingPanelReclaimIntent()).toBe(false)
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('preserves terminal focus when dragging the titlebar from inside the floating panel', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebar = findByProp(element, 'data-floating-terminal-shortcut-surface')
    const panelElement = { focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    const titlebarTarget = { closest: vi.fn().mockReturnValue(null) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    attachRef(panel.props.ref, panelElement)
    vi.stubGlobal('document', { activeElement })

    ;(titlebar.props.onPointerDown as (event: unknown) => void)({
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1,
      target: titlebarTarget
    })

    expect(panelElement.focus).not.toHaveBeenCalled()
  })

  it('focuses the floating panel for titlebar shortcuts when focus starts outside it', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebar = findByProp(element, 'data-floating-terminal-shortcut-surface')
    const panelElement = { focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(null) }
    const titlebarTarget = { closest: vi.fn().mockReturnValue(null) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    attachRef(panel.props.ref, panelElement)
    vi.stubGlobal('document', { activeElement })

    ;(titlebar.props.onPointerDown as (event: unknown) => void)({
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1,
      target: titlebarTarget
    })

    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})
