import type * as ReactModule from 'react'
import type * as StoreModule from '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import {
  cleanupGlobalEffectsTestWindow,
  createLivePaneManagerRegistry,
  installGlobalEffectsTestWindow
} from './use-terminal-pane-global-effects-test-harness'

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  focusActivePane: vi.fn(),
  flushTerminalOutput: vi.fn(),
  getTerminalOutputEpoch: vi.fn(() => 0),
  handleTerminalFileDrop: vi.fn(),
  enforceTerminalCurrentScrollIntent: vi.fn(),
  syncTerminalScrollIntentFromViewport: vi.fn(),
  pasteTerminalText: vi.fn(),
  recordTerminalUserInputForLeaf: vi.fn(),
  requestTerminalBacklogRecovery: vi.fn(),
  restoreScrollState: vi.fn(),
  restoreScrollStateAfterLayout: vi.fn()
}))

const reactRefState = vi.hoisted(() => ({
  slots: [] as { current: unknown }[],
  index: 0
}))

function beginHookRender(): void {
  reactRefState.index = 0
}

function resetHookRefs(): void {
  reactRefState.slots = []
  reactRefState.index = 0
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => {
      const index = reactRefState.index
      reactRefState.index += 1
      if (!reactRefState.slots[index]) {
        reactRefState.slots[index] = { current: value }
      }
      return reactRefState.slots[index] as { current: T }
    }
  }
})

vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: mocks.fitAndFocusPanes,
  fitPanes: mocks.fitPanes,
  focusActivePane: mocks.focusActivePane
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput,
  requestTerminalBacklogRecovery: mocks.requestTerminalBacklogRecovery
}))

vi.mock('@/lib/pane-manager/pane-scroll', () => ({
  captureScrollState: mocks.captureScrollState,
  getTerminalOutputEpoch: mocks.getTerminalOutputEpoch,
  restoreScrollState: mocks.restoreScrollState,
  restoreScrollStateAfterLayout: mocks.restoreScrollStateAfterLayout
}))

vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  enforceTerminalCurrentScrollIntent: mocks.enforceTerminalCurrentScrollIntent,
  syncTerminalScrollIntentFromViewport: mocks.syncTerminalScrollIntentFromViewport
}))

vi.mock('./terminal-drop-handler', () => ({
  handleTerminalFileDrop: mocks.handleTerminalFileDrop
}))

vi.mock('./terminal-bracketed-paste', () => ({
  BRACKETED_PASTE_END: '\u001b[201~',
  BRACKETED_PASTE_START: '\u001b[200~',
  pasteTerminalText: mocks.pasteTerminalText,
  sanitizeTerminalPasteText: (text: string) => text.split('\u001b').join('\u241b')
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

// Why: this suite invokes the hook outside a real React render (the react mock
// above runs effects synchronously and manages refs by hand), so a reactive
// useAppStore(selector) call would throw an "Invalid hook call". Read the
// current snapshot synchronously instead; getState/setState stay real so tests
// can seed terminalLayoutsByTabId.
vi.mock('@/store', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>()
  const realHook = actual.useAppStore
  const testHook = ((selector?: (state: ReturnType<typeof realHook.getState>) => unknown) =>
    selector ? selector(realHook.getState()) : realHook.getState()) as typeof realHook
  Object.assign(testHook, realHook)
  return { ...actual, useAppStore: testHook }
})

describe('useTerminalPaneGlobalEffects', () => {
  const { registerManagerForReset, unregisterAllManagers } = createLivePaneManagerRegistry()

  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    installGlobalEffectsTestWindow()
  })

  afterEach(() => {
    unregisterAllManagers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    cleanupGlobalEffectsTestWindow()
  })

  it('keeps the shared glyph atlas warm on plain window refocus', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    // Why: deliberate reversal of the #6354 focus-clear. A refocus atlas wipe
    // forces every pane to re-rasterize at once, and xterm's page-merge
    // clear-model flag is consumed by a single renderer (#4480), so panes that
    // lose the race paint garbled glyphs while an agent streams. Focus must
    // stay a WebGL-retry + pane-scoped repaint boundary only.
    registerManagerForReset(manager)
    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const focusListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === 'focus')

    expect(focusListener).toBeDefined()
    const listener = focusListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected focus listener')
    }
    manager.resetWebglTextureAtlases.mockClear()
    manager.scheduleRevealRepaint.mockClear()
    manager.scheduleRevealPresent.mockClear()
    listener(new Event('focus'))
    listener(new Event('focus'))
    listener(new Event('focus'))

    // Count proof: repeated refocus performs zero shared-atlas wipes. It routes
    // to the atlas-preserving present (scheduleRevealPresent), never the
    // atlas-clearing reveal repaint, which would clear each pane's shared atlas.
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(manager.scheduleRevealRepaint).not.toHaveBeenCalled()
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(3)
  })

  it('recovers visible terminal rendering and input when the window regains focus', () => {
    const terminal = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      refreshAllPanes: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => ({ id: 1, terminal }))
    }

    registerManagerForReset(manager)
    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const focusListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === 'focus')

    expect(focusListener).toBeDefined()
    const listener = focusListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected focus listener')
    }
    manager.resumeRendering.mockClear()
    manager.resetWebglTextureAtlases.mockClear()
    manager.refreshAllPanes.mockClear()
    // Clear the mount-time reveal spies so the assertions measure only the
    // focus event, not the initial visibility resume.
    manager.scheduleRevealRepaint.mockClear()
    manager.scheduleRevealPresent.mockClear()
    manager.fitAllRevealedPanes.mockClear()
    mocks.fitAndFocusPanes.mockClear()
    mocks.focusActivePane.mockClear()
    mocks.flushTerminalOutput.mockClear()
    mocks.requestTerminalBacklogRecovery.mockClear()

    listener(new Event('focus'))

    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledWith(terminal)
    expect(mocks.flushTerminalOutput).toHaveBeenCalledWith(terminal, { maxChars: 64 * 1024 })
    expect(manager.resumeRendering).toHaveBeenCalledTimes(1)
    // Refocus recovery uses the same wobble-resistant reveal fit path.
    expect(manager.fitAllRevealedPanes).toHaveBeenCalledTimes(1)
    expect(mocks.focusActivePane).toHaveBeenCalledWith(manager)
    expect(mocks.fitAndFocusPanes).not.toHaveBeenCalled()
    // Why: refocus recovery is atlas-preserving — no shared-atlas reset, no
    // registry-wide repaint, and no atlas-clearing reveal repaint; the
    // atlas-preserving present covers stale pixels.
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
    expect(manager.scheduleRevealRepaint).not.toHaveBeenCalled()
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(1)
  })

  it('clears WebGL texture atlases when the OS resumes', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      refreshAllPanes: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }
    const captured: { onSystemResumed: (() => void) | null } = { onSystemResumed: null }
    const unsubscribeSystemResumed = vi.fn()
    ;(
      window.api.ui as unknown as { onSystemResumed: (callback: () => void) => () => void }
    ).onSystemResumed = vi.fn((callback: () => void) => {
      captured.onSystemResumed = callback
      return unsubscribeSystemResumed
    })

    registerManagerForReset(manager)
    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    expect(captured.onSystemResumed).toBeTypeOf('function')
    manager.resetWebglTextureAtlases.mockClear()
    manager.refreshAllPanes.mockClear()
    captured.onSystemResumed?.()

    // Why: OS resume is a genuine wake — GPU state may be stale without a
    // context-loss event, so the shared-atlas clear and full repaint still run.
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('preserves WebGL texture atlases when the active terminal document becomes visible', () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    const documentListeners = new Map<string, EventListenerOrEventListenerObject>()
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
        documentListeners.set(eventName, listener)
      }),
      removeEventListener: vi.fn()
    })
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }
    const siblingManager = {
      resetWebglTextureAtlases: vi.fn()
    }

    registerManagerForReset(manager)
    registerManagerForReset(siblingManager)
    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const listener = documentListeners.get('visibilitychange')
    expect(listener).toBeDefined()
    if (typeof listener !== 'function') {
      throw new Error('expected visibilitychange listener')
    }
    manager.resetWebglTextureAtlases.mockClear()
    manager.scheduleRevealPresent.mockClear()
    siblingManager.resetWebglTextureAtlases.mockClear()
    listener(new Event('visibilitychange'))
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(siblingManager.resetWebglTextureAtlases).not.toHaveBeenCalled()

    visibilityState = 'visible'
    listener(new Event('visibilitychange'))

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(siblingManager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(1)
  })

  it('registers document visibility recovery for visible inactive terminals but not hidden ones', () => {
    const addEventListener = vi.fn()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener,
      removeEventListener: vi.fn()
    })
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }
    const useMountForVisibilityRecovery = (options: {
      isActive: boolean
      isVisible: boolean
    }): void => {
      resetHookRefs()
      beginHookRender()
      useTerminalPaneGlobalEffects({
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        isActive: options.isActive,
        isVisible: options.isVisible,
        isSyncFitEnabled: options.isVisible,
        paneCount: 0,
        managerRef: { current: manager as never },
        containerRef: { current: null },
        paneTransportsRef: { current: new Map() },
        isActiveRef: { current: false },
        isVisibleRef: { current: false },
        toggleExpandPane: vi.fn()
      })
    }

    useMountForVisibilityRecovery({ isActive: false, isVisible: true })
    expect(
      addEventListener.mock.calls.some(([eventName]) => eventName === 'visibilitychange')
    ).toBe(true)

    addEventListener.mockClear()
    useMountForVisibilityRecovery({ isActive: true, isVisible: false })

    expect(
      addEventListener.mock.calls.some(([eventName]) => eventName === 'visibilitychange')
    ).toBe(false)
  })
})
