import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armFloatingPanelReclaimIntent,
  consumeFloatingPanelReclaimIntent
} from '@/lib/floating-workspace-focus-reclaim'
import { ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT } from '@/components/editor/editor-autosave'
import {
  makeFile,
  makeTab,
  setFloatingEditorTabs,
  setFloatingTabs
} from './floating-terminal-panel-test-fixtures'
import { mocks, setupFloatingTerminalPanelTest } from './floating-terminal-panel-test-harness'
import {
  attachRef,
  findByProp,
  findByTypeName,
  renderPanel,
  runEffects
} from './floating-terminal-panel-render-probe'

function requestedEditorCloseReaction(): () => void {
  const event = vi
    .mocked(window.dispatchEvent)
    .mock.calls.map(([candidate]) => candidate)
    .find((candidate) => candidate.type === ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT)
  if (!(event instanceof CustomEvent)) {
    throw new Error('the editor close was not requested')
  }
  const detail: unknown = event.detail
  if (!detail || typeof detail !== 'object' || !('onClosed' in detail)) {
    throw new Error('the close request has no settlement reaction')
  }
  const onClosed = detail.onClosed
  if (typeof onClosed !== 'function') {
    throw new Error('the close reaction is not callable')
  }
  return () => onClosed()
}

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

    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )

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

    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')

    // Schedule reclaim without firing it so unmount must cancel the pending frame.
    setFloatingTabs([])
    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, null)

    // Only deferred reclaim uses frame 42; the empty panel’s separate open-focus effect is synchronous.
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
  })

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
    // Model a deferred/canceled pin confirmation by never firing onClosed.
    mocks.closeTerminalTab.mockImplementationOnce(() => {})
    const element = await renderPanel(true)
    attachRef(findByProp(element, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')

    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ onClosed: expect.any(Function) })
    )
    expect(consumeFloatingPanelReclaimIntent()).toBe(false)
  })

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

    const onClosed = requestedEditorCloseReaction()
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-a')
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()

    // The close callback arms reclaim after removal; its deferred frame distinguishes it from synchronous open-focus.
    setFloatingEditorTabs([])
    onClosed()
    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    // The probe reads external-store snapshots on render; React re-renders on the arm notification.
    const afterArm = await renderPanel(true)
    attachRef(findByProp(afterArm, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    expect(window.requestAnimationFrame).toHaveBeenCalled()
    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('reclaims focus when intent arms after the empty panel has rendered', async () => {
    setFloatingTabs([])
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()
    vi.mocked(window.requestAnimationFrame).mockClear()

    armFloatingPanelReclaimIntent()
    const afterArm = await renderPanel(true)
    attachRef(findByProp(afterArm, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    expect(window.requestAnimationFrame).toHaveBeenCalled()
    expect(consumeFloatingPanelReclaimIntent()).toBe(false)
  })

  it('does not reclaim after a cancelled dirty-editor close', async () => {
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
    requestedEditorCloseReaction()

    setFloatingEditorTabs([])
    const emptyElement = await renderPanel(true)
    attachRef(findByProp(emptyElement, 'data-floating-terminal-panel').props.ref, panelElement)
    runEffects()

    // The empty panel’s synchronous open-focus may run, but no reclaim frame should be armed.
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
