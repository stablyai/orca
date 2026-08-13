import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalScrollVisibilityMemory } from './use-terminal-scroll-visibility-memory'

const mocks = vi.hoisted(() => ({
  cancelDeferredScrollRestore: vi.fn(),
  captureScrollState: vi.fn(() => ({
    bufferType: 'normal',
    wasAtBottom: true,
    viewportY: 0,
    baseY: 0
  })),
  flushTerminalOutput: vi.fn(),
  getTerminalOutputEpoch: vi.fn(() => 1),
  getTerminalScrollIntentKind: vi.fn(() => 'followOutput'),
  markTerminalFollowOutput: vi.fn(),
  markTerminalPinnedViewport: vi.fn(),
  releaseScrollStateMarker: vi.fn(),
  restoreScrollState: vi.fn(() => true)
}))

const reactRefState = vi.hoisted(() => ({
  effectCleanups: [] as (() => void)[],
  slots: [] as { current: unknown }[],
  index: 0
}))

function beginHookRender(): void {
  reactRefState.index = 0
}

function resetHookRefs(): void {
  reactRefState.effectCleanups = []
  reactRefState.slots = []
  reactRefState.index = 0
}

function runEffectCleanups(): void {
  for (const cleanup of reactRefState.effectCleanups.splice(0)) {
    cleanup()
  }
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        reactRefState.effectCleanups.push(cleanup)
      }
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

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput
}))

vi.mock('@/lib/pane-manager/pane-scroll', () => ({
  cancelDeferredScrollRestore: mocks.cancelDeferredScrollRestore,
  captureScrollState: mocks.captureScrollState,
  getTerminalOutputEpoch: mocks.getTerminalOutputEpoch,
  releaseScrollStateMarker: mocks.releaseScrollStateMarker,
  restoreScrollState: mocks.restoreScrollState
}))

vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  getTerminalScrollIntentKind: mocks.getTerminalScrollIntentKind,
  markTerminalFollowOutput: mocks.markTerminalFollowOutput,
  markTerminalPinnedViewport: mocks.markTerminalPinnedViewport
}))

describe('useTerminalScrollVisibilityMemory', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    mocks.getTerminalScrollIntentKind.mockReturnValue('followOutput')
    // mockClear leaves queued once-values behind; drop them so a case that
    // consumes fewer than it queues cannot bleed into the next one.
    mocks.captureScrollState.mockReset()
    mocks.captureScrollState.mockReturnValue({
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 0,
      baseY: 0
    })
    mocks.restoreScrollState.mockReset()
    mocks.restoreScrollState.mockReturnValue(true)
  })

  afterEach(() => {
    runEffectCleanups()
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    } else {
      delete (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    } else {
      delete (globalThis as unknown as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
    }
  })

  it('bounds follow-output flushes when applying pending requests', () => {
    const terminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      scrollToBottom: vi.fn()
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }])
    }
    const animationFrames: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    })

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    visibilityMemory.scheduleFollowOutputIfNeeded(1)
    animationFrames.shift()?.(16)
    animationFrames.shift()?.(32)

    expect(mocks.flushTerminalOutput).toHaveBeenCalledWith(terminal, {
      maxChars: 256 * 1024
    })
    expect(terminal.scrollToBottom).toHaveBeenCalled()
    expect(mocks.markTerminalFollowOutput).toHaveBeenCalledWith(terminal)
  })

  it('does not turn a pinned viewport into follow-output when pending focus requests catch up', () => {
    mocks.getTerminalScrollIntentKind.mockReturnValue('pinnedViewport')
    const terminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      scrollToBottom: vi.fn()
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }])
    }
    const animationFrames: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    })

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    visibilityMemory.scheduleFollowOutputIfNeeded(1)
    animationFrames.shift()?.(16)
    animationFrames.shift()?.(32)

    expect(mocks.flushTerminalOutput).toHaveBeenCalledWith(terminal, {
      maxChars: 256 * 1024
    })
    expect(mocks.cancelDeferredScrollRestore).not.toHaveBeenCalled()
    expect(mocks.markTerminalFollowOutput).not.toHaveBeenCalled()
    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
  })

  it('restores a remembered pinned viewport and re-pins the durable intent', () => {
    // Regression (#8715): the hide-time snapshot was captured but never replayed,
    // so returning to the worktree left the pane at the top of the scrollback.
    const pinned = { bufferType: 'normal', wasAtBottom: false, viewportY: 500, baseY: 5000 }
    const reanchored = { bufferType: 'normal', wasAtBottom: false, viewportY: 500, baseY: 5000 }
    mocks.captureScrollState.mockReturnValueOnce(pinned).mockReturnValueOnce(reanchored)
    const terminal = { onScroll: vi.fn(() => ({ dispose: vi.fn() })) }
    const manager = { getPanes: vi.fn(() => [{ id: 1, terminal }]) }

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    visibilityMemory.captureViewportPositions(false)
    const restored = visibilityMemory.restoreRememberedPinnedViewports()

    expect(mocks.restoreScrollState).toHaveBeenCalledWith(terminal, pinned)
    expect(mocks.markTerminalPinnedViewport).toHaveBeenCalledWith(terminal)
    expect(restored).toEqual(new Set([1]))
    // restoreScrollState disposes the markers, so the entry must be re-anchored.
    expect(mocks.captureScrollState).toHaveBeenCalledTimes(2)
  })

  it('leaves follow-output and alternate-buffer panes to their existing resume paths', () => {
    mocks.captureScrollState
      .mockReturnValueOnce({
        bufferType: 'normal',
        wasAtBottom: true,
        viewportY: 5000,
        baseY: 5000
      })
      .mockReturnValueOnce({
        bufferType: 'alternate',
        wasAtBottom: false,
        viewportY: 0,
        baseY: 0
      })
    const following = { onScroll: vi.fn(() => ({ dispose: vi.fn() })) }
    const altScreen = { onScroll: vi.fn(() => ({ dispose: vi.fn() })) }
    const manager = {
      getPanes: vi.fn(() => [
        { id: 1, terminal: following },
        { id: 2, terminal: altScreen }
      ])
    }

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 2
    })

    visibilityMemory.captureViewportPositions(false)
    const restored = visibilityMemory.restoreRememberedPinnedViewports()

    expect(mocks.restoreScrollState).not.toHaveBeenCalled()
    expect(restored.size).toBe(0)
  })

  it('releases the previous markers when a pane snapshot is replaced', () => {
    const first = { bufferType: 'normal', wasAtBottom: false, viewportY: 10, baseY: 100 }
    mocks.captureScrollState.mockReturnValueOnce(first)
    const terminal = { onScroll: vi.fn(() => ({ dispose: vi.fn() })) }
    const manager = { getPanes: vi.fn(() => [{ id: 1, terminal }]) }

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    visibilityMemory.captureViewportPositions(false)
    expect(mocks.releaseScrollStateMarker).not.toHaveBeenCalled()
    visibilityMemory.captureViewportPositions(false)

    expect(mocks.releaseScrollStateMarker).toHaveBeenCalledWith(first)
  })

  it('cancels pending follow-output frames on cleanup', () => {
    const terminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      scrollToBottom: vi.fn()
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }])
    }
    const cancelAnimationFrame = vi.fn()
    globalThis.requestAnimationFrame = vi.fn(() => 7)
    globalThis.cancelAnimationFrame = cancelAnimationFrame

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    visibilityMemory.scheduleFollowOutputIfNeeded(1)
    runEffectCleanups()

    expect(cancelAnimationFrame).toHaveBeenCalledWith(7)
    expect(mocks.flushTerminalOutput).not.toHaveBeenCalled()
  })
})
