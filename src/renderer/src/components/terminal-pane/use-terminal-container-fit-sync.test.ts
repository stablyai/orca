import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld
} from '@/lib/pane-manager/pane-pty-resize-hold'
import {
  isTerminalContainerResizeSettling,
  resetTerminalContainerResizeSettleForTests
} from '@/lib/pane-manager/terminal-container-resize-settle'
import { useTerminalContainerFitSync } from './use-terminal-container-fit-sync'

const mocks = vi.hoisted(() => ({
  cleanupCallbacks: [] as (() => void)[],
  fitPanes: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        mocks.cleanupCallbacks.push(cleanup)
      }
    }
  }
})

vi.mock('./pane-helpers', () => ({
  fitPanes: mocks.fitPanes
}))

type ResizeObserverCallbackLike = ConstructorParameters<typeof ResizeObserver>[0]

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallbackLike) {
    mockResizeObservers.push(this)
  }

  trigger(): void {
    this.callback([], this as never)
  }
}

let mockResizeObservers: MockResizeObserver[] = []

function createPaneElement(): HTMLElement {
  return {
    classList: { contains: (className: string) => className === 'pane' },
    dispatchEvent: vi.fn()
  } as unknown as HTMLElement
}

describe('useTerminalContainerFitSync', () => {
  beforeEach(() => {
    mockResizeObservers = []
    mocks.cleanupCallbacks = []
    mocks.fitPanes.mockClear()
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })

  afterEach(() => {
    for (const cleanup of mocks.cleanupCallbacks.splice(0)) {
      cleanup()
    }
    resetTerminalContainerResizeSettleForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (globalThis as { window?: unknown }).window
  })

  it('fits once after container resize settles and flushes the final held PTY size', () => {
    const paneElement = createPaneElement()
    const container = {
      classList: { contains: () => false },
      querySelectorAll: () => [paneElement]
    } as unknown as HTMLDivElement
    const manager = { fitAllPanes: vi.fn() }

    useTerminalContainerFitSync({
      isVisible: true,
      isSyncFitEnabled: true,
      managerRef: { current: manager as never },
      containerRef: { current: container }
    })

    mockResizeObservers[0]?.trigger()

    expect(isTerminalContainerResizeSettling()).toBe(true)
    expect(queuePanePtyResizeIfHeld(paneElement, 100, 30)).toBe(true)

    vi.advanceTimersByTime(149)

    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(paneElement.dispatchEvent).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)

    expect(mocks.fitPanes).toHaveBeenCalledTimes(1)
    expect(isTerminalContainerResizeSettling()).toBe(false)
    expect(paneElement.dispatchEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(paneElement.dispatchEvent).mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT)
    expect(event.detail).toEqual({ cols: 100, rows: 30 })
  })

  it('cancels a held PTY resize when the observed container unmounts before settling', () => {
    const paneElement = createPaneElement()
    const container = {
      classList: { contains: () => false },
      querySelectorAll: () => [paneElement]
    } as unknown as HTMLDivElement

    useTerminalContainerFitSync({
      isVisible: true,
      isSyncFitEnabled: true,
      managerRef: { current: { fitAllPanes: vi.fn() } as never },
      containerRef: { current: container }
    })

    mockResizeObservers[0]?.trigger()
    expect(queuePanePtyResizeIfHeld(paneElement, 90, 25)).toBe(true)

    for (const cleanup of mocks.cleanupCallbacks.splice(0)) {
      cleanup()
    }
    vi.advanceTimersByTime(150)

    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(paneElement.dispatchEvent).not.toHaveBeenCalled()
    expect(isTerminalContainerResizeSettling()).toBe(false)
  })
})
