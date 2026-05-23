import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  flushTerminalOutput: vi.fn(),
  getTerminalOutputEpoch: vi.fn(() => 0),
  handleTerminalFileDrop: vi.fn(),
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
  flushTerminalOutput: mocks.flushTerminalOutput
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
    paneCount?: number
  } = {}
): {
  onFileDrop: DropCallback
  manager: {
    getPanes: ReturnType<typeof vi.fn>
    resumeRendering: ReturnType<typeof vi.fn>
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
  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    ;(globalThis as unknown as { window: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        ui: {
          onFileDrop: vi.fn(() => vi.fn())
        }
      }
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
  })

  afterEach(() => {
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
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    mocks.flushTerminalOutput.mockImplementation((terminal: { name: string }) => {
      order.push(`flush:${terminal.name}`)
    })
    mocks.captureScrollState.mockImplementation((terminal: { name: string }) => {
      order.push(`capture:${terminal.name}`)
      return { terminalName: terminal.name }
    })
    mocks.restoreScrollStateAfterLayout.mockImplementation((terminal: { name: string }) => {
      order.push(`restore:${terminal.name}`)
    })
    mocks.fitAndFocusPanes.mockImplementation(() => order.push('fit-focus'))

    const isActiveRef = { current: false }
    const isVisibleRef = { current: false }
    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
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
      'flush:terminal-a',
      'flush:terminal-b',
      'resume',
      'fit-focus',
      'restore:terminal-a',
      'restore:terminal-b'
    ])
    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(isActiveRef.current).toBe(true)
    expect(isVisibleRef.current).toBe(true)
  })

  it('restores from the pre-hide scroll state when hidden layout changes the viewport', () => {
    const terminalA = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal: terminalA }]),
      resumeRendering: vi.fn(),
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
})
