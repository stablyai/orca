/* eslint-disable max-lines -- Why: these hook tests share a mocked React lifecycle harness with global event cases. */
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASTE_TERMINAL_TEXT_EVENT, SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  flushTerminalOutput: vi.fn(),
  getTerminalOutputEpoch: vi.fn(() => 0),
  handleTerminalFileDrop: vi.fn(),
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
  fitPanes: mocks.fitPanes
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

vi.mock('./terminal-drop-handler', () => ({
  handleTerminalFileDrop: mocks.handleTerminalFileDrop
}))

vi.mock('./terminal-bracketed-paste', () => ({
  pasteTerminalText: mocks.pasteTerminalText
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

type DropCallback = (data: { paths: string[]; target: string; tabId?: string }) => void

function useMountForFileDrop(
  options: {
    tabId?: string
    worktreeId?: string
    cwd?: string
    isActive?: boolean
    isVisible?: boolean
    isSyncFitEnabled?: boolean
    paneCount?: number
  } = {}
): {
  onFileDrop: DropCallback
  manager: {
    getPanes: ReturnType<typeof vi.fn>
    resumeRendering: ReturnType<typeof vi.fn>
    resetWebglTextureAtlases: ReturnType<typeof vi.fn>
    suspendRendering: ReturnType<typeof vi.fn>
    getActivePane: ReturnType<typeof vi.fn>
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
    suspendRendering: vi.fn(),
    getActivePane: vi.fn(() => null)
  }
  const paneTransports = new Map<number, never>()

  beginHookRender()
  useTerminalPaneGlobalEffects({
    tabId: options.tabId ?? 'tab-1',
    worktreeId: options.worktreeId ?? 'wt-1',
    cwd: options.cwd,
    isActive: options.isActive ?? true,
    isVisible: options.isVisible ?? true,
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
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
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
      'fit-focus',
      'restore:terminal-a',
      'restore:terminal-b',
      'reset-atlas'
    ])
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

  it('reports the active local PTY to the main output scheduler', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal: { name: 'terminal-a' } }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      suspendRendering: vi.fn(),
      getActivePane: vi.fn(() => ({ id: 1, terminal: { name: 'terminal-a' } }))
    }
    const transport = { getPtyId: vi.fn(() => 'pty-active') }
    const paneTransports = new Map([[1, transport]])

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
      paneTransportsRef: { current: paneTransports as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    expect(window.api.pty.setActiveRendererPty).toHaveBeenCalledWith('pty-active', true)
  })

  it('restores from the pre-hide scroll state when hidden layout changes the viewport', () => {
    const terminalA = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal: terminalA }]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
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
    expect(mocks.restoreScrollStateAfterLayout).toHaveBeenLastCalledWith(terminalA, preHideState)
  })

  it('clears WebGL texture atlases when the active visible terminal regains focus', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      suspendRendering: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    // Why: focus recovery resets every registered manager (shared glyph
    // atlas), so the fake manager observes the reset through the registry.
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
    listener(new Event('focus'))

    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
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
      suspendRendering: vi.fn(),
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
      suspendRendering: vi.fn(),
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

  it('records terminal input for targeted paste events', () => {
    const terminal = { name: 'terminal-a', focus: vi.fn() }
    const pane = { id: 1, leafId: 'leaf-1', terminal }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      suspendRendering: vi.fn(),
      getActivePane: vi.fn(() => pane)
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
      paneTransportsRef: { current: new Map() },
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

    expect(mocks.pasteTerminalText).toHaveBeenCalledWith(terminal, 'git status')
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

    const data = { paths: ['/tmp/image.png'], target: 'terminal', tabId: 'tab-1' }
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
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
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
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
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
