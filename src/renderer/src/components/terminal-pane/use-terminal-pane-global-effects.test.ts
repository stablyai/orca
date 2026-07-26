/* eslint-disable max-lines -- Why: these hook tests share a mocked React lifecycle harness with global event cases. */
import type * as ReactModule from 'react'
import type * as StoreModule from '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASTE_TERMINAL_TEXT_EVENT, SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import { useAppStore } from '@/store'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from './terminal-paste-coordinator'

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

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

type DropCallback = (data: {
  paths: string[]
  target: string
  tabId?: string
  paneLeafId?: string
}) => void

async function flushPasteTasks(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function useMountForFileDrop(
  options: {
    tabId?: string
    worktreeId?: string
    cwd?: string
    isActive?: boolean
    isVisible?: boolean
    isWorktreeActive?: boolean
    isSyncFitEnabled?: boolean
    paneCount?: number
  } = {}
): {
  onFileDrop: DropCallback
  manager: {
    getPanes: ReturnType<typeof vi.fn>
    resumeRendering: ReturnType<typeof vi.fn>
    resetWebglTextureAtlases: ReturnType<typeof vi.fn>
    scheduleRevealRepaint: ReturnType<typeof vi.fn>
    scheduleRevealPresent: ReturnType<typeof vi.fn>
    suspendRendering: ReturnType<typeof vi.fn>
    getActivePane: ReturnType<typeof vi.fn>
    fitAllRevealedPanes: ReturnType<typeof vi.fn>
  }
  paneTransports: Map<number, never>
} {
  let onFileDrop: DropCallback = () => {
    throw new Error('onFileDrop callback was not registered')
  }
  window.api.ui.onFileDrop = vi.fn((callback) => {
    onFileDrop = callback
    return vi.fn()
  })
  const manager = {
    getPanes: vi.fn(() => []),
    resumeRendering: vi.fn(),
    resetWebglTextureAtlases: vi.fn(),
    scheduleRevealRepaint: vi.fn(),
    scheduleRevealPresent: vi.fn(),
    suspendRendering: vi.fn(),
    getActivePane: vi.fn(() => null),
    fitAllRevealedPanes: vi.fn()
  }
  const paneTransports = new Map<number, never>()

  beginHookRender()
  useTerminalPaneGlobalEffects({
    tabId: options.tabId ?? 'tab-1',
    worktreeId: options.worktreeId ?? 'wt-1',
    cwd: options.cwd,
    isActive: options.isActive ?? true,
    isVisible: options.isVisible ?? true,
    isWorktreeActive: options.isWorktreeActive ?? options.isVisible ?? true,
    isSyncFitEnabled: options.isSyncFitEnabled ?? options.isVisible ?? true,
    paneCount: options.paneCount ?? 0,
    managerRef: { current: manager as never },
    containerRef: { current: null },
    paneTransportsRef: { current: paneTransports },
    isActiveRef: { current: false },
    isVisibleRef: { current: false },
    toggleExpandPane: vi.fn()
  })

  return { onFileDrop, manager, paneTransports }
}

describe('useTerminalPaneGlobalEffects', () => {
  // Why: the live-manager registry is module-global; unregister in afterEach
  // so a failed assertion cannot leak fake managers into later tests.
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  function registerManagerForReset<T extends { resetWebglTextureAtlases(): void }>(manager: T): T {
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    return manager
  }

  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    useAppStore.setState({ terminalLayoutsByTabId: {} })
    ;(globalThis as unknown as { window: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        ui: {
          onFileDrop: vi.fn(() => vi.fn())
        },
        pty: {
          setActiveRendererPty: vi.fn()
        }
      }
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
  })

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver
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
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
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
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
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

  function seedActiveLeafPty(tabId: string, activeLeafId: string, ptyId: string): void {
    useAppStore.setState({
      terminalLayoutsByTabId: {
        [tabId]: {
          root: null,
          activeLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [activeLeafId]: ptyId }
        }
      }
    })
  }

  function makeActivePtyManager(): {
    getPanes: ReturnType<typeof vi.fn>
    resumeRendering: ReturnType<typeof vi.fn>
    resetWebglTextureAtlases: ReturnType<typeof vi.fn>
    scheduleRevealRepaint: ReturnType<typeof vi.fn>
    scheduleRevealPresent: ReturnType<typeof vi.fn>
    suspendRendering: ReturnType<typeof vi.fn>
    fitAllRevealedPanes: ReturnType<typeof vi.fn>
    getActivePane: ReturnType<typeof vi.fn>
  } {
    return {
      getPanes: vi.fn(() => [{ id: 1, terminal: { name: 'terminal-a' } }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => ({ id: 1, terminal: { name: 'terminal-a' } }))
    }
  }

  it('reports the active local PTY to the main output scheduler', () => {
    const manager = makeActivePtyManager()
    seedActiveLeafPty('tab-1', 'leaf-1', 'pty-active')

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

    expect(window.api.pty.setActiveRendererPty).toHaveBeenCalledWith('pty-active', true)
  })

  it('re-reports the active PTY when the active leaf rebinds to a new PTY without visibility changing', () => {
    const manager = makeActivePtyManager()
    const mountArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isWorktreeActive: true,
      isSyncFitEnabled: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    }

    seedActiveLeafPty('tab-1', 'leaf-1', 'pty-old')
    beginHookRender()
    useTerminalPaneGlobalEffects(mountArgs)
    expect(window.api.pty.setActiveRendererPty).toHaveBeenCalledWith('pty-old', true)

    // Deferred reattach rebinds the active leaf to a new PTY; isActive/isVisible/
    // isWorktreeActive never flip, so only the reactive leaf→PTY binding changes.
    seedActiveLeafPty('tab-1', 'leaf-1', 'pty-new')
    beginHookRender()
    useTerminalPaneGlobalEffects(mountArgs)

    expect(window.api.pty.setActiveRendererPty).toHaveBeenCalledWith('pty-new', true)
  })

  it('does not report a backgrounded tab active even when its active leaf has a live PTY', () => {
    const manager = makeActivePtyManager()
    seedActiveLeafPty('tab-1', 'leaf-1', 'pty-active')

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      isVisible: false,
      isWorktreeActive: false,
      isSyncFitEnabled: false,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    expect(window.api.pty.setActiveRendererPty).not.toHaveBeenCalled()
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

  it('clears WebGL texture atlases when the active visible terminal document becomes visible', () => {
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
    siblingManager.resetWebglTextureAtlases.mockClear()
    listener(new Event('visibilitychange'))
    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(siblingManager.resetWebglTextureAtlases).not.toHaveBeenCalled()

    visibilityState = 'visible'
    listener(new Event('visibilitychange'))

    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(siblingManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
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

  it('records terminal input for targeted paste events', async () => {
    const terminal = { name: 'terminal-a', focus: vi.fn(), modes: { bracketedPasteMode: false } }
    const pane = { id: 1, leafId: 'leaf-1', terminal }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => pane)
    }
    const transport = {
      getPtyId: vi.fn(() => 'pty-1'),
      isConnected: vi.fn(() => true),
      sendInput: vi.fn<(data: string) => boolean>(() => true)
    }

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
      paneTransportsRef: { current: new Map([[pane.id, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const pasteListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === PASTE_TERMINAL_TEXT_EVENT)

    expect(pasteListener).toBeDefined()
    const listener = pasteListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected paste listener')
    }
    listener(
      new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, { detail: { tabId: 'tab-1', text: 'git status' } })
    )

    await flushPasteTasks()

    expect(mocks.pasteTerminalText).toHaveBeenCalledWith(terminal, 'git status', {
      forceBracketedPaste: false
    })
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(terminal.focus).toHaveBeenCalledOnce()
  })

  it('chunks large programmatic paste events through the pane PTY transport', async () => {
    const largePaste = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
    const terminal = { name: 'terminal-a', focus: vi.fn(), modes: { bracketedPasteMode: false } }
    const pane = { id: 1, leafId: 'leaf-1', terminal }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => pane)
    }
    const transport = {
      getPtyId: vi.fn(() => 'pty-1'),
      isConnected: vi.fn(() => true),
      sendInput: vi.fn<(data: string) => boolean>(() => true)
    }

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
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const pasteListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === PASTE_TERMINAL_TEXT_EVENT)

    expect(pasteListener).toBeDefined()
    const listener = pasteListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected paste listener')
    }
    listener(
      new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, { detail: { tabId: 'tab-1', text: largePaste } })
    )

    await flushPasteTasks(12)

    expect(mocks.pasteTerminalText).not.toHaveBeenCalled()
    expect(transport.sendInput.mock.calls.map((call) => call[0]).join('')).toBe(largePaste)
    expect(transport.sendInput.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(terminal.focus).toHaveBeenCalledOnce()
  })

  it('ignores terminal file drops for another terminal tab', () => {
    const { onFileDrop } = useMountForFileDrop()

    onFileDrop({ paths: ['/tmp/image.png'], target: 'terminal', tabId: 'tab-2' })

    expect(mocks.handleTerminalFileDrop).not.toHaveBeenCalled()
  })

  it('handles terminal file drops for the matching terminal tab', () => {
    const { onFileDrop, manager, paneTransports } = useMountForFileDrop({
      cwd: '/worktree'
    })

    const data = {
      paths: ['/tmp/image.png'],
      target: 'terminal',
      tabId: 'tab-1',
      paneLeafId: 'leaf-1'
    }
    onFileDrop(data)

    expect(mocks.handleTerminalFileDrop).toHaveBeenCalledWith({
      manager,
      paneTransports,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: '/worktree',
      data
    })
  })

  it('keeps handling legacy terminal file drops without a terminal tab id', () => {
    const { onFileDrop, manager, paneTransports } = useMountForFileDrop()

    const data = { paths: ['/tmp/image.png'], target: 'terminal' }
    onFileDrop(data)

    expect(mocks.handleTerminalFileDrop).toHaveBeenCalledWith({
      manager,
      paneTransports,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data
    })
  })

  it('handles terminal file drops for visible unfocused split-group terminals', () => {
    const { onFileDrop } = useMountForFileDrop({ isActive: false, isVisible: true })

    onFileDrop({ paths: ['/tmp/image.png'], target: 'terminal', tabId: 'tab-1' })

    expect(mocks.handleTerminalFileDrop).toHaveBeenCalledTimes(1)
  })

  it('ignores legacy terminal file drops in visible unfocused split-group terminals', () => {
    const { onFileDrop } = useMountForFileDrop({ isActive: false, isVisible: true })

    onFileDrop({ paths: ['/tmp/image.png'], target: 'terminal' })

    expect(mocks.handleTerminalFileDrop).not.toHaveBeenCalled()
  })

  it('skips global sync-fit registration for hidden non-measurable terminal panes', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      isVisible: false,
      isSyncFitEnabled: false,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const syncFitListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === SYNC_FIT_PANES_EVENT)

    expect(syncFitListener).toBeUndefined()
  })

  it('registers global sync-fit for measurable hidden startup panes', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      isVisible: false,
      isSyncFitEnabled: true,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const syncFitListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === SYNC_FIT_PANES_EVENT)

    expect(syncFitListener).toBeDefined()
    const listener = syncFitListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected sync-fit listener')
    }
    listener(new Event(SYNC_FIT_PANES_EVENT))
    expect(manager.fitAllPanes).toHaveBeenCalledTimes(1)
  })
})
