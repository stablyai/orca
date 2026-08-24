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

  it('flushes visible terminal panes before resuming rendering and fitting', () => {
    const order: string[] = []
    const terminalA = { name: 'terminal-a' }
    const terminalB = { name: 'terminal-b' }
    const manager = {
      getPanes: vi.fn(() => [
        { id: 1, terminal: terminalA },
        { id: 2, terminal: terminalB }
      ]),
      resumeRendering: vi.fn(() => order.push('resume')),
      resetWebglTextureAtlases: vi.fn(() => order.push('reset-atlas')),
      scheduleRevealRepaint: vi.fn(() => order.push('reveal-repaint')),
      scheduleRevealPresent: vi.fn(() => order.push('reveal-present')),
      refreshAllPanes: vi.fn(() => order.push('refresh')),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(() => order.push('fit-reveal')),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    mocks.flushTerminalOutput.mockImplementation((terminal: { name: string }) => {
      order.push(`flush:${terminal.name}`)
    })
    mocks.requestTerminalBacklogRecovery.mockImplementation((terminal: { name: string }) => {
      order.push(`recover:${terminal.name}`)
    })
    mocks.captureScrollState.mockImplementation((terminal: { name: string }) => {
      order.push(`capture:${terminal.name}`)
      return { terminalName: terminal.name }
    })
    mocks.restoreScrollStateAfterLayout.mockImplementation((terminal: { name: string }) => {
      order.push(`restore:${terminal.name}`)
    })
    mocks.enforceTerminalCurrentScrollIntent.mockImplementation((terminal: { name: string }) => {
      order.push(`intent:${terminal.name}`)
    })
    mocks.fitAndFocusPanes.mockImplementation(() => order.push('fit-focus'))

    // Why: the resume path resets atlases through the live-manager registry
    // (shared glyph atlas), so the fake manager must be registered to observe
    // its reset in the ordering assertion.
    registerManagerForReset(manager)
    const isActiveRef = { current: false }
    const isVisibleRef = { current: false }
    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 2,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef,
      isVisibleRef,
      toggleExpandPane: vi.fn()
    })

    expect(order).toEqual([
      'capture:terminal-a',
      'capture:terminal-b',
      'recover:terminal-a',
      'flush:terminal-a',
      'recover:terminal-b',
      'flush:terminal-b',
      'resume',
      'fit-reveal',
      'intent:terminal-a',
      'intent:terminal-b',
      'reset-atlas',
      'refresh',
      'reveal-repaint'
    ])
    expect(mocks.restoreScrollStateAfterLayout).not.toHaveBeenCalled()
    expect(mocks.flushTerminalOutput).toHaveBeenNthCalledWith(1, terminalA, {
      maxChars: 256 * 1024
    })
    expect(mocks.flushTerminalOutput).toHaveBeenNthCalledWith(2, terminalB, {
      maxChars: 256 * 1024
    })
    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(isActiveRef.current).toBe(true)
    expect(isVisibleRef.current).toBe(true)
  })

  it('uses a light resume for tab switches while the worktree stays active', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const terminal = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      refreshAllPanes: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    registerManagerForReset(manager)
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      isWorktreeActive: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    manager.resumeRendering.mockClear()
    manager.resetWebglTextureAtlases.mockClear()
    manager.scheduleRevealRepaint.mockClear()
    manager.scheduleRevealPresent.mockClear()
    manager.refreshAllPanes.mockClear()
    manager.suspendRendering.mockClear()
    mocks.fitAndFocusPanes.mockClear()
    mocks.fitPanes.mockClear()
    mocks.focusActivePane.mockClear()
    mocks.flushTerminalOutput.mockClear()
    mocks.requestTerminalBacklogRecovery.mockClear()

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    expect(manager.suspendRendering).not.toHaveBeenCalled()

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledWith(terminal)
    expect(mocks.flushTerminalOutput).not.toHaveBeenCalled()
    expect(manager.resumeRendering).not.toHaveBeenCalled()
    expect(mocks.fitAndFocusPanes).not.toHaveBeenCalled()
    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
    expect(manager.scheduleRevealRepaint).not.toHaveBeenCalled()
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(1)
    expect(mocks.focusActivePane).toHaveBeenCalledWith(manager)
    vi.advanceTimersByTime(500)
  })

  it('keeps visible active-state updates on the light resume path', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const terminal = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      refreshAllPanes: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    registerManagerForReset(manager)
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      isWorktreeActive: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: true
    })

    manager.resumeRendering.mockClear()
    manager.resetWebglTextureAtlases.mockClear()
    manager.scheduleRevealRepaint.mockClear()
    manager.scheduleRevealPresent.mockClear()
    manager.refreshAllPanes.mockClear()
    mocks.fitAndFocusPanes.mockClear()
    mocks.fitPanes.mockClear()
    mocks.focusActivePane.mockClear()
    mocks.flushTerminalOutput.mockClear()
    mocks.requestTerminalBacklogRecovery.mockClear()

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledWith(terminal)
    expect(mocks.flushTerminalOutput).not.toHaveBeenCalled()
    expect(manager.resumeRendering).not.toHaveBeenCalled()
    expect(mocks.fitAndFocusPanes).not.toHaveBeenCalled()
    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
    expect(manager.scheduleRevealRepaint).not.toHaveBeenCalled()
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(1)
    expect(mocks.focusActivePane).toHaveBeenCalledWith(manager)
    vi.advanceTimersByTime(500)
  })

  it('suspends rendering when a terminal tab first mounts hidden', () => {
    const terminal = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      refreshAllPanes: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    registerManagerForReset(manager)
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      isWorktreeActive: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    expect(manager.suspendRendering).toHaveBeenCalledTimes(1)

    manager.suspendRendering.mockClear()
    manager.resumeRendering.mockClear()
    mocks.flushTerminalOutput.mockClear()
    mocks.requestTerminalBacklogRecovery.mockClear()

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledWith(terminal)
    expect(mocks.flushTerminalOutput).toHaveBeenCalledWith(terminal, { maxChars: 256 * 1024 })
    expect(manager.resumeRendering).toHaveBeenCalledTimes(1)
  })

  it('suspends a tab-hidden terminal when its worktree surface becomes hidden', () => {
    const terminal = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      refreshAllPanes: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    registerManagerForReset(manager)
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true,
      isWorktreeActive: true
    })

    manager.suspendRendering.mockClear()

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false,
      isWorktreeActive: true
    })
    expect(manager.suspendRendering).not.toHaveBeenCalled()

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false,
      isWorktreeActive: false
    })

    expect(manager.suspendRendering).toHaveBeenCalledTimes(1)

    manager.resumeRendering.mockClear()
    manager.resetWebglTextureAtlases.mockClear()
    manager.refreshAllPanes.mockClear()
    manager.fitAllRevealedPanes.mockClear()
    mocks.fitAndFocusPanes.mockClear()
    mocks.focusActivePane.mockClear()
    mocks.flushTerminalOutput.mockClear()
    mocks.requestTerminalBacklogRecovery.mockClear()

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true,
      isWorktreeActive: true
    })

    expect(mocks.requestTerminalBacklogRecovery).toHaveBeenCalledWith(terminal)
    expect(mocks.flushTerminalOutput).toHaveBeenCalledWith(terminal, { maxChars: 256 * 1024 })
    expect(manager.resumeRendering).toHaveBeenCalledTimes(1)
    // Reveal must route through fitAllRevealedPanes, never the sync fitAllPanes.
    expect(manager.fitAllRevealedPanes).toHaveBeenCalledTimes(1)
    expect(manager.fitAllPanes).not.toHaveBeenCalled()
    expect(mocks.focusActivePane).toHaveBeenCalledWith(manager)
    expect(mocks.fitAndFocusPanes).not.toHaveBeenCalled()
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('enforces scroll intent after hidden layout changes the viewport', () => {
    const terminalA = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal: terminalA }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const initialState = { marker: 'initial' }
    const preHideState = { marker: 'before-hide' }
    const corruptedHiddenState = { marker: 'hidden-corrupted' }
    let nextCapturedState = initialState
    mocks.captureScrollState.mockImplementation(() => nextCapturedState)

    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    nextCapturedState = preHideState
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    nextCapturedState = corruptedHiddenState
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(mocks.captureScrollState).toHaveBeenCalledTimes(2)
    expect(manager.suspendRendering).toHaveBeenCalledTimes(1)
    expect(mocks.restoreScrollStateAfterLayout).not.toHaveBeenCalled()
    expect(mocks.enforceTerminalCurrentScrollIntent).toHaveBeenLastCalledWith(terminalA)
  })
})
