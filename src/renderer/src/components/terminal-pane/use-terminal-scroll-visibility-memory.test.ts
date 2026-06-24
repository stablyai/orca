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
  getPendingScrollRestoreState: vi.fn((): unknown => null),
  getTerminalOutputEpoch: vi.fn(() => 1),
  isTerminalScrollRestoreInProgress: vi.fn(() => false),
  rememberTerminalContainerScrollState: vi.fn(),
  rememberTerminalLeafScrollState: vi.fn(),
  rememberTerminalScrollState: vi.fn()
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
  getPendingScrollRestoreState: mocks.getPendingScrollRestoreState,
  getTerminalOutputEpoch: mocks.getTerminalOutputEpoch,
  isTerminalScrollRestoreInProgress: mocks.isTerminalScrollRestoreInProgress,
  rememberTerminalContainerScrollState: mocks.rememberTerminalContainerScrollState,
  rememberTerminalLeafScrollState: mocks.rememberTerminalLeafScrollState,
  rememberTerminalScrollState: mocks.rememberTerminalScrollState
}))

describe('useTerminalScrollVisibilityMemory', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    mocks.captureScrollState.mockReset()
    mocks.getPendingScrollRestoreState.mockReset()
    mocks.getTerminalOutputEpoch.mockReset()
    mocks.isTerminalScrollRestoreInProgress.mockReset()
    mocks.captureScrollState.mockImplementation(() => ({
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 0,
      baseY: 0
    }))
    mocks.getPendingScrollRestoreState.mockImplementation(() => null)
    mocks.getTerminalOutputEpoch.mockImplementation(() => 1)
    mocks.isTerminalScrollRestoreInProgress.mockImplementation(() => false)
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
      getPanes: vi.fn(() => [{ id: 1, leafId: 'leaf-1', terminal }])
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

    visibilityMemory.scheduleFollowOutputIfNeeded('leaf-1' as never)
    animationFrames.shift()?.(16)
    animationFrames.shift()?.(32)

    expect(mocks.flushTerminalOutput).toHaveBeenCalledWith(terminal, {
      maxChars: 256 * 1024
    })
    expect(terminal.scrollToBottom).toHaveBeenCalled()
  })

  it('cancels pending follow-output frames on cleanup', () => {
    const terminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      scrollToBottom: vi.fn()
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, leafId: 'leaf-1', terminal }])
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

    visibilityMemory.scheduleFollowOutputIfNeeded('leaf-1' as never)
    runEffectCleanups()

    expect(cancelAnimationFrame).toHaveBeenCalledWith(7)
    expect(mocks.flushTerminalOutput).not.toHaveBeenCalled()
  })

  it('does not remember scroll events caused by a deferred restore', () => {
    const onScrollListeners: (() => void)[] = []
    const terminal = {
      onScroll: vi.fn((listener: () => void) => {
        onScrollListeners.push(listener)
        return { dispose: vi.fn() }
      })
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, leafId: 'leaf-1', terminal }])
    }
    const userScrolledState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }
    const restoreBottomState = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 100,
      baseY: 100
    }
    mocks.captureScrollState
      .mockReturnValueOnce(userScrolledState)
      .mockReturnValueOnce(restoreBottomState)

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    const listener = onScrollListeners[0]
    if (!listener) {
      throw new Error('expected onScroll listener to be registered')
    }
    listener()
    mocks.isTerminalScrollRestoreInProgress.mockReturnValueOnce(true)
    listener()

    expect(visibilityMemory.captureViewportPositions(true).get('leaf-1' as never)).toBe(
      userScrolledState
    )
    expect(mocks.captureScrollState).toHaveBeenCalledTimes(1)
  })

  it('keeps the remembered non-bottom position when xterm reports a transient edge snap', () => {
    const onScrollListeners: (() => void)[] = []
    const terminal = {
      onScroll: vi.fn((listener: () => void) => {
        onScrollListeners.push(listener)
        return { dispose: vi.fn() }
      })
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, leafId: 'leaf-1', terminal }])
    }
    const userScrolledState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }
    const transientTopState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 0,
      baseY: 100
    }
    mocks.captureScrollState
      .mockReturnValueOnce(userScrolledState)
      .mockReturnValueOnce(transientTopState)

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })
    onScrollListeners[0]?.()

    expect(visibilityMemory.captureViewportPositions(false).get('leaf-1' as never)).toBe(
      userScrolledState
    )
    expect(visibilityMemory.captureViewportPositions(true).get('leaf-1' as never)).toBe(
      userScrolledState
    )
  })

  it('captures the pending restore target while a visibility restore is settling', () => {
    const terminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() }))
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, leafId: 'leaf-1', terminal }])
    }
    const pendingRestoreState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 150,
      baseY: 154
    }
    mocks.getPendingScrollRestoreState.mockReturnValue(pendingRestoreState)
    mocks.captureScrollState.mockReturnValue({
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 56,
      baseY: 154
    })

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    expect(visibilityMemory.captureViewportPositions(false).get('leaf-1' as never)).toBe(
      pendingRestoreState
    )
  })

  it('does not reuse a remembered snapshot when a pane id gets a new leaf', () => {
    const terminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() }))
    }
    let panes = [{ id: 1, leafId: 'old-leaf', terminal }]
    const manager = {
      getPanes: vi.fn(() => panes)
    }
    const oldBottomState = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 100,
      baseY: 100
    }
    const newLeafState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }
    let currentState = oldBottomState
    mocks.captureScrollState.mockImplementation(() => currentState)

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })

    expect(visibilityMemory.captureViewportPositions(false).get('old-leaf' as never)).toStrictEqual(
      oldBottomState
    )
    panes = [{ id: 1, leafId: 'new-leaf', terminal }]
    currentState = newLeafState

    expect(visibilityMemory.captureViewportPositions(true).get('new-leaf' as never)).toStrictEqual(
      newLeafState
    )
    expect(mocks.captureScrollState).toHaveBeenCalledTimes(2)
  })

  it('does not apply pending follow-output to a reused pane id with a different leaf', () => {
    const oldTerminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      scrollToBottom: vi.fn()
    }
    const newTerminal = {
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      scrollToBottom: vi.fn()
    }
    let panes = [{ id: 1, leafId: 'old-leaf', terminal: oldTerminal }]
    const manager = {
      getPanes: vi.fn(() => panes)
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

    visibilityMemory.scheduleFollowOutputIfNeeded('old-leaf' as never)
    panes = [{ id: 1, leafId: 'new-leaf', terminal: newTerminal }]
    animationFrames.shift()?.(16)
    animationFrames.shift()?.(32)

    expect(oldTerminal.scrollToBottom).not.toHaveBeenCalled()
    expect(newTerminal.scrollToBottom).not.toHaveBeenCalled()
    expect(mocks.flushTerminalOutput).not.toHaveBeenCalled()
  })

  it('does not follow output when the remembered visible position was not at bottom', () => {
    const onScrollListeners: (() => void)[] = []
    const terminal = {
      onScroll: vi.fn((listener: () => void) => {
        onScrollListeners.push(listener)
        return { dispose: vi.fn() }
      }),
      scrollToBottom: vi.fn()
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, leafId: 'leaf-1', terminal }])
    }
    const animationFrames: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    mocks.captureScrollState.mockReturnValue({
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    })

    beginHookRender()
    const visibilityMemory = useTerminalScrollVisibilityMemory({
      managerRef: { current: manager as never },
      isVisibleRef: { current: true },
      visibleResumeCompleteRef: { current: true },
      paneCount: 1
    })
    onScrollListeners[0]?.()

    visibilityMemory.scheduleFollowOutputIfNeeded('leaf-1' as never)
    animationFrames.shift()?.(16)
    animationFrames.shift()?.(32)

    expect(mocks.flushTerminalOutput).toHaveBeenCalledWith(terminal, {
      maxChars: 256 * 1024
    })
    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
  })
})
