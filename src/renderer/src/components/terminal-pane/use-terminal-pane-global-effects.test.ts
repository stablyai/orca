/* oxlint-disable max-lines -- Why: these tests exercise one hook's visibility,
hydration, scroll, paste, and file-drop effects against a shared mocked React
ref harness; splitting would duplicate brittle setup. */
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { queueHiddenTerminalOutput } from './hidden-terminal-output-state'

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
    replayingPanesRef: { current: new Map() },
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
        },
        pty: {
          serializeHeadlessBuffer: vi.fn().mockResolvedValue(null)
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
      replayingPanesRef: { current: new Map() },
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

  it('hydrates hidden terminal output from the headless snapshot when becoming visible', async () => {
    const terminal = {
      name: 'terminal-a',
      options: { scrollback: 1000 },
      write: vi.fn((_data: string, callback?: () => void) => callback?.())
    }
    const pane = { id: 1, terminal }
    const transport = { getPtyId: vi.fn(() => 'pty-1') }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const replayingPanesRef = { current: new Map<number, number>() }
    const isVisibleRef = { current: false }
    queueHiddenTerminalOutput(terminal, 'pty-1', 'fallback-hidden-output')
    window.api.pty.serializeHeadlessBuffer = vi.fn().mockResolvedValue({
      data: 'headless-current-output',
      cols: 120,
      rows: 40
    })

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      replayingPanesRef,
      isActiveRef: { current: false },
      isVisibleRef,
      toggleExpandPane: vi.fn()
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(window.api.pty.serializeHeadlessBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 1000
    })
    expect(terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', expect.any(Function))
    expect(terminal.write).toHaveBeenCalledWith('headless-current-output', expect.any(Function))
    expect(terminal.write).not.toHaveBeenCalledWith('fallback-hidden-output', expect.any(Function))
  })

  it('keeps reveal-time output queued until the headless hydration completes', async () => {
    const terminal = {
      name: 'terminal-a',
      options: { scrollback: 1000 },
      write: vi.fn((_data: string, callback?: () => void) => callback?.())
    }
    const pane = { id: 1, terminal }
    const transport = { getPtyId: vi.fn(() => 'pty-1') }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    let resolveSnapshot!: (snapshot: { data: string; cols: number; rows: number } | null) => void
    const snapshotPromise = new Promise<{ data: string; cols: number; rows: number } | null>(
      (resolve) => {
        resolveSnapshot = resolve
      }
    )
    window.api.pty.serializeHeadlessBuffer = vi.fn(
      () => snapshotPromise
    ) as typeof window.api.pty.serializeHeadlessBuffer
    queueHiddenTerminalOutput(terminal, 'pty-1', 'fallback-hidden-output')

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      replayingPanesRef: { current: new Map<number, number>() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })
    queueHiddenTerminalOutput(terminal, 'pty-1', 'arrived-during-hydration')

    resolveSnapshot({ data: 'headless-current-output', cols: 120, rows: 40 })
    await Promise.resolve()
    await Promise.resolve()

    expect(terminal.write).toHaveBeenCalledWith('headless-current-output', expect.any(Function))
    expect(terminal.write).toHaveBeenCalledWith('arrived-during-hydration', expect.any(Function))
    expect(terminal.write).not.toHaveBeenCalledWith('fallback-hidden-output', expect.any(Function))
  })

  it('does not let stale hydration clear output queued for a rebound PTY', async () => {
    const terminal = {
      name: 'terminal-a',
      options: { scrollback: 1000 },
      write: vi.fn((_data: string, callback?: () => void) => callback?.())
    }
    const pane = { id: 1, terminal }
    let currentPtyId = 'pty-1'
    const transport = { getPtyId: vi.fn(() => currentPtyId) }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    let resolveSnapshot!: (snapshot: { data: string; cols: number; rows: number } | null) => void
    const snapshotPromise = new Promise<{ data: string; cols: number; rows: number } | null>(
      (resolve) => {
        resolveSnapshot = resolve
      }
    )
    window.api.pty.serializeHeadlessBuffer = vi.fn((id: string) => {
      if (id === 'pty-1') {
        return snapshotPromise
      }
      return Promise.resolve(null)
    }) as typeof window.api.pty.serializeHeadlessBuffer
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      replayingPanesRef: { current: new Map<number, number>() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    }
    queueHiddenTerminalOutput(terminal, 'pty-1', 'old-output')

    beginHookRender()
    useTerminalPaneGlobalEffects(baseArgs)

    currentPtyId = 'pty-2'
    queueHiddenTerminalOutput(terminal, 'pty-2', 'new-output')
    resolveSnapshot({ data: 'stale-headless-output', cols: 120, rows: 40 })
    await Promise.resolve()
    await Promise.resolve()

    expect(terminal.write).not.toHaveBeenCalledWith('stale-headless-output', expect.any(Function))
    terminal.write.mockClear()

    beginHookRender()
    useTerminalPaneGlobalEffects(baseArgs)
    await Promise.resolve()
    await Promise.resolve()

    expect(window.api.pty.serializeHeadlessBuffer).toHaveBeenCalledWith('pty-2', {
      scrollbackRows: 1000
    })
    expect(terminal.write).toHaveBeenCalledWith('new-output', expect.any(Function))
  })

  it('does not replay stale hydration after the pane transport is replaced', async () => {
    const terminal = {
      name: 'terminal-a',
      options: { scrollback: 1000 },
      write: vi.fn((_data: string, callback?: () => void) => callback?.())
    }
    const pane = { id: 1, terminal }
    const oldTransport = { getPtyId: vi.fn(() => 'pty-1') }
    const newTransport = { getPtyId: vi.fn(() => 'pty-2') }
    const paneTransports = new Map<number, typeof oldTransport | typeof newTransport>([
      [1, oldTransport]
    ])
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    let resolveSnapshot!: (snapshot: { data: string; cols: number; rows: number } | null) => void
    const snapshotPromise = new Promise<{ data: string; cols: number; rows: number } | null>(
      (resolve) => {
        resolveSnapshot = resolve
      }
    )
    window.api.pty.serializeHeadlessBuffer = vi.fn((id: string) => {
      if (id === 'pty-1') {
        return snapshotPromise
      }
      return Promise.resolve(null)
    }) as typeof window.api.pty.serializeHeadlessBuffer
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: paneTransports as never },
      replayingPanesRef: { current: new Map<number, number>() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    }
    queueHiddenTerminalOutput(terminal, 'pty-1', 'old-output')

    beginHookRender()
    useTerminalPaneGlobalEffects(baseArgs)

    paneTransports.set(1, newTransport)
    queueHiddenTerminalOutput(terminal, 'pty-2', 'new-output')
    resolveSnapshot({ data: 'stale-headless-output', cols: 120, rows: 40 })
    await Promise.resolve()
    await Promise.resolve()

    expect(terminal.write).not.toHaveBeenCalledWith('stale-headless-output', expect.any(Function))
    terminal.write.mockClear()

    beginHookRender()
    useTerminalPaneGlobalEffects(baseArgs)
    await Promise.resolve()
    await Promise.resolve()

    expect(window.api.pty.serializeHeadlessBuffer).toHaveBeenCalledWith('pty-2', {
      scrollbackRows: 1000
    })
    expect(terminal.write).toHaveBeenCalledWith('new-output', expect.any(Function))
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
      replayingPanesRef: { current: new Map() },
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
