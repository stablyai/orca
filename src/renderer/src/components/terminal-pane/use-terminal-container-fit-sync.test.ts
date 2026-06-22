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
import {
  TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS,
  TERMINAL_CONTAINER_RESIZE_MAX_SETTLE_MS,
  useTerminalContainerFitSync
} from './use-terminal-container-fit-sync'

const mocks = vi.hoisted(() => ({
  cleanupCallbacks: [] as (() => void)[],
  fitPanes: vi.fn(),
  minimizedChangedCallbacks: [] as ((isMinimized: boolean) => void)[],
  unsubscribeMinimizedChanged: vi.fn()
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
      removeEventListener: vi.fn(),
      api: {
        ui: {
          onMinimizedChanged: vi.fn((callback: (isMinimized: boolean) => void) => {
            mocks.minimizedChangedCallbacks.push(callback)
            return mocks.unsubscribeMinimizedChanged
          })
        }
      }
    }
    mocks.minimizedChangedCallbacks = []
    mocks.unsubscribeMinimizedChanged.mockClear()
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

    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1)

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

  it('flushes the held PTY resize when the manager is unavailable at settle time', () => {
    const paneElement = createPaneElement()
    const container = {
      classList: { contains: () => false },
      querySelectorAll: () => [paneElement]
    } as unknown as HTMLDivElement

    useTerminalContainerFitSync({
      isVisible: true,
      isSyncFitEnabled: true,
      managerRef: { current: null },
      containerRef: { current: container }
    })

    mockResizeObservers[0]?.trigger()
    expect(queuePanePtyResizeIfHeld(paneElement, 101, 31)).toBe(true)

    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS)

    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(isTerminalContainerResizeSettling()).toBe(false)
    expect(paneElement.dispatchEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(paneElement.dispatchEvent).mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT)
    expect(event.detail).toEqual({ cols: 101, rows: 31 })
  })

  it('resets the quiet-period debounce when resize observations continue', () => {
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
    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1)
    mockResizeObservers[0]?.trigger()
    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1)

    expect(mocks.fitPanes).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)

    expect(mocks.fitPanes).toHaveBeenCalledTimes(1)
  })

  it('forces a final fit when resize observations never go quiet', () => {
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
    expect(queuePanePtyResizeIfHeld(paneElement, 110, 32)).toBe(true)

    let elapsedMs = 0
    while (
      elapsedMs + TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS <
      TERMINAL_CONTAINER_RESIZE_MAX_SETTLE_MS
    ) {
      vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1)
      elapsedMs += TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1
      mockResizeObservers[0]?.trigger()
    }

    expect(mocks.fitPanes).not.toHaveBeenCalled()

    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_MAX_SETTLE_MS - elapsedMs)

    expect(mocks.fitPanes).toHaveBeenCalledTimes(1)
    expect(isTerminalContainerResizeSettling()).toBe(false)
    expect(paneElement.dispatchEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(paneElement.dispatchEvent).mock.calls[0]?.[0] as CustomEvent
    expect(event.detail).toEqual({ cols: 110, rows: 32 })
  })

  it('does not fit twice when the quiet and max-settle timers converge', () => {
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
    expect(queuePanePtyResizeIfHeld(paneElement, 115, 33)).toBe(true)

    let elapsedMs = 0
    const finalObservationMs =
      TERMINAL_CONTAINER_RESIZE_MAX_SETTLE_MS - TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS
    while (elapsedMs + TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1 < finalObservationMs) {
      vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1)
      elapsedMs += TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS - 1
      mockResizeObservers[0]?.trigger()
    }
    vi.advanceTimersByTime(finalObservationMs - elapsedMs)
    mockResizeObservers[0]?.trigger()

    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS)
    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS)

    expect(mocks.fitPanes).toHaveBeenCalledTimes(1)
    expect(isTerminalContainerResizeSettling()).toBe(false)
    expect(paneElement.dispatchEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(paneElement.dispatchEvent).mock.calls[0]?.[0] as CustomEvent
    expect(event.detail).toEqual({ cols: 115, rows: 33 })
  })

  it('holds resize work while the window is minimized and flushes after restore settles', () => {
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

    mocks.minimizedChangedCallbacks[0]?.(true)
    expect(isTerminalContainerResizeSettling()).toBe(true)
    expect(queuePanePtyResizeIfHeld(paneElement, 120, 35)).toBe(true)

    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_MAX_SETTLE_MS * 2)

    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(paneElement.dispatchEvent).not.toHaveBeenCalled()
    expect(isTerminalContainerResizeSettling()).toBe(true)

    mocks.minimizedChangedCallbacks[0]?.(false)
    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS)

    expect(mocks.fitPanes).toHaveBeenCalledTimes(1)
    expect(isTerminalContainerResizeSettling()).toBe(false)
    expect(paneElement.dispatchEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(paneElement.dispatchEvent).mock.calls[0]?.[0] as CustomEvent
    expect(event.detail).toEqual({ cols: 120, rows: 35 })
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
    vi.advanceTimersByTime(TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS)

    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(paneElement.dispatchEvent).not.toHaveBeenCalled()
    expect(isTerminalContainerResizeSettling()).toBe(false)
    expect(mocks.unsubscribeMinimizedChanged).toHaveBeenCalled()
  })
})
