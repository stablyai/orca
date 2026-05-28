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
  getTerminalOutputEpoch: vi.fn(() => 1)
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

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput
}))

vi.mock('@/lib/pane-manager/pane-scroll', () => ({
  cancelDeferredScrollRestore: mocks.cancelDeferredScrollRestore,
  captureScrollState: mocks.captureScrollState,
  getTerminalOutputEpoch: mocks.getTerminalOutputEpoch
}))

describe('useTerminalScrollVisibilityMemory', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame

  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    } else {
      delete (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame
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
  })
})
