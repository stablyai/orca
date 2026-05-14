import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'

const mocks = vi.hoisted(() => ({
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  flushTerminalOutput: vi.fn(),
  handleTerminalFileDrop: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => ({ current: value })
  }
})

vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: mocks.fitAndFocusPanes,
  fitPanes: mocks.fitPanes
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput
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

  useTerminalPaneGlobalEffects({
    tabId: options.tabId ?? 'tab-1',
    worktreeId: options.worktreeId ?? 'wt-1',
    cwd: options.cwd,
    isActive: options.isActive ?? true,
    isVisible: options.isVisible ?? true,
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
    mocks.fitAndFocusPanes.mockImplementation(() => order.push('fit-focus'))

    const isActiveRef = { current: false }
    const isVisibleRef = { current: false }
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef,
      isVisibleRef,
      toggleExpandPane: vi.fn()
    })

    expect(order).toEqual(['flush:terminal-a', 'flush:terminal-b', 'resume', 'fit-focus'])
    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(isActiveRef.current).toBe(true)
    expect(isVisibleRef.current).toBe(true)
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
