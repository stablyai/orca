// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
  callRuntimeRpc: mocks.callRuntimeRpc
}))

import {
  useRemoteBrowserPageInput,
  useRemoteBrowserPageInputQueue
} from './use-remote-browser-page-input'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import {
  REMOTE_BROWSER_PRESS_HOLD_MS,
  REMOTE_BROWSER_PRESS_MAX_AGE_MS
} from './remote-browser-page-input-model'

const VIEWPORT = { width: 800, height: 600 }

function pointerEvent(
  overrides: Partial<{
    clientX: number
    clientY: number
    button: number
    pointerId: number
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
  }> = {}
): React.PointerEvent<HTMLImageElement> {
  return {
    clientX: 100,
    clientY: 100,
    button: 0,
    pointerId: 1,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
    ...overrides
  } as unknown as React.PointerEvent<HTMLImageElement>
}

function renderInput(): {
  input: ReturnType<typeof useRemoteBrowserPageInput>
  image: HTMLImageElement
  clearPendingRemotePress: () => void
  paintNextFrame: () => void
  unmount: () => void
  settle: () => Promise<void>
} {
  const image = document.createElement('img')
  const viewport = document.createElement('div')
  viewport.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height }) as DOMRect
  const pending: Promise<void>[] = []
  // The screencast mints one blob URL per painted frame.
  let frameUrl = 'blob:remote-frame-1'
  let paintedFrames = 1
  // The pane's own composition: the queue hook owns the pending-press ref the input hook fills.
  const { result, rerender, unmount } = renderHook(() => {
    const queue = useRemoteBrowserPageInputQueue()
    const input = useRemoteBrowserPageInput({
      busy: false,
      imageRef: { current: image },
      remoteViewportRef: { current: viewport },
      remoteCssViewportSizeRef: { current: VIEWPORT },
      remoteViewportSizeRef: { current: null },
      frameMetadata: null,
      frameUrl,
      runtimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' }),
      lifecycle: { tokens: { remotePage: 'page-1' } } as unknown as RemoteBrowserStreamLifecycle,
      runtimeWorktree: 'wt-1',
      enqueueRemoteInput: (operation) => {
        const next = queue.enqueueRemoteInput(operation)
        pending.push(next)
        return next
      },
      createRemoteOperationToken: () => ({
        tabId: 'tab-1',
        environmentId: 'env-1',
        remotePageId: 'page-1',
        generation: 1
      }),
      isCurrentRemoteOperationToken: () => true,
      closeMissingRemotePage: vi.fn(),
      scheduleRemoteTabInfoRefresh: vi.fn(),
      setPaneNotice: vi.fn(),
      pendingPressRef: queue.pendingPressRef
    })
    return { input, clearPendingRemotePress: queue.clearPendingRemotePress }
  })
  return {
    input: result.current.input,
    image,
    clearPendingRemotePress: result.current.clearPendingRemotePress,
    paintNextFrame: () => {
      paintedFrames += 1
      frameUrl = `blob:remote-frame-${paintedFrames}`
      rerender()
    },
    unmount,
    settle: async () => {
      await Promise.all(pending)
    }
  }
}

function calledMethods(): string[] {
  return mocks.callRuntimeRpc.mock.calls.map((call) => call[1] as string)
}

describe('remote browser pointer input', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hovers the click point, then sends one atomic mouseClick for a press and release at the same point', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 120, clientY: 90 }))
    input.handleRemotePointerUp(pointerEvent({ clientX: 121, clientY: 91 }))
    await settle()

    // The move is what applies :hover before the press hit-test; the host's mouseClick sends none.
    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseClick'])
    expect(mocks.callRuntimeRpc.mock.calls[0][2]).toEqual({
      worktree: 'wt-1',
      page: 'page-1',
      x: 121,
      y: 91
    })
    expect(mocks.callRuntimeRpc.mock.calls[1][2]).toEqual({
      worktree: 'wt-1',
      page: 'page-1',
      x: 121,
      y: 91,
      button: 'left'
    })
  })

  it('keeps the move/down/move/up chain for a drag', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    input.handleRemotePointerUp(pointerEvent({ clientX: 300, clientY: 260 }))
    await settle()

    expect(calledMethods()).toEqual([
      'browser.mouseMove',
      'browser.mouseDown',
      'browser.mouseMove',
      'browser.mouseUp'
    ])
    expect(mocks.callRuntimeRpc.mock.calls[0][2]).toMatchObject({ x: 100, y: 100 })
    expect(mocks.callRuntimeRpc.mock.calls[2][2]).toMatchObject({ x: 300, y: 260 })
  })

  it('keeps the legacy chain for modified clicks, which carry no modifiers today', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ shiftKey: true }))
    input.handleRemotePointerUp(pointerEvent({ shiftKey: true }))
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown', 'browser.mouseUp'])
  })

  it('falls back to the chain on hosts without mouseClick and stops re-probing them', async () => {
    mocks.callRuntimeRpc.mockImplementation(async (_target, method: string) => {
      if (method === 'browser.mouseClick') {
        throw Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
      }
      return {}
    })
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    input.handleRemotePointerUp(pointerEvent())
    await settle()

    expect(calledMethods()).toEqual([
      'browser.mouseMove',
      'browser.mouseClick',
      'browser.mouseMove',
      'browser.mouseDown',
      'browser.mouseUp'
    ])

    mocks.callRuntimeRpc.mockClear()
    input.handleRemotePointerDown(pointerEvent())
    input.handleRemotePointerUp(pointerEvent())
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown', 'browser.mouseUp'])
  })

  it('sends nothing for a release whose press was cancelled or never recorded', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    input.handleRemotePointerCancel()
    input.handleRemotePointerUp(pointerEvent())
    await settle()

    expect(calledMethods()).toEqual([])
  })

  it('drops a release whose button differs from the recorded press', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ button: 1 }))
    input.handleRemotePointerUp(pointerEvent({ button: 0 }))
    await settle()

    expect(calledMethods()).toEqual([])
  })

  it('sends a middle click atomically', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ button: 1 }))
    input.handleRemotePointerUp(pointerEvent({ button: 1 }))
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseClick'])
    expect(mocks.callRuntimeRpc.mock.calls[1][2]).toMatchObject({ button: 'middle' })
  })

  it('puts the button down while a press is still held, and the release only lifts it', async () => {
    vi.useFakeTimers()
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    await vi.advanceTimersByTimeAsync(REMOTE_BROWSER_PRESS_HOLD_MS + 10)

    // The page must see the button go down during the hold, or long-press and hold-to-repeat
    // affordances never fire and the pane shows no :active feedback.
    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown'])
    expect(mocks.callRuntimeRpc.mock.calls[0][2]).toMatchObject({ x: 100, y: 100 })

    input.handleRemotePointerUp(pointerEvent({ clientX: 140, clientY: 130 }))
    await settle()

    expect(calledMethods()).toEqual([
      'browser.mouseMove',
      'browser.mouseDown',
      'browser.mouseMove',
      'browser.mouseUp'
    ])
    expect(mocks.callRuntimeRpc.mock.calls[2][2]).toMatchObject({ x: 140, y: 130 })
  })

  it('still sends the atomic click when the press releases before the hold threshold', async () => {
    vi.useFakeTimers()
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    await vi.advanceTimersByTimeAsync(REMOTE_BROWSER_PRESS_HOLD_MS - 50)
    input.handleRemotePointerUp(pointerEvent())
    await settle()
    await vi.advanceTimersByTimeAsync(REMOTE_BROWSER_PRESS_HOLD_MS)

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseClick'])
  })

  it('lifts a held button when the press is cancelled', async () => {
    vi.useFakeTimers()
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    await vi.advanceTimersByTimeAsync(REMOTE_BROWSER_PRESS_HOLD_MS + 10)
    input.handleRemotePointerCancel()
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown', 'browser.mouseUp'])
  })

  it('lifts a held button when the pane identity changes under it', async () => {
    vi.useFakeTimers()
    const { input, clearPendingRemotePress, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    await vi.advanceTimersByTimeAsync(REMOTE_BROWSER_PRESS_HOLD_MS + 10)
    clearPendingRemotePress()
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown', 'browser.mouseUp'])
  })

  it('lifts a held button when the pane unmounts mid-hold', async () => {
    vi.useFakeTimers()
    const { input, unmount, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    await vi.advanceTimersByTimeAsync(REMOTE_BROWSER_PRESS_HOLD_MS + 10)
    unmount()
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown', 'browser.mouseUp'])
  })

  it('captures the pointer so a release outside the frame still reaches the press', () => {
    const { input, image } = renderInput()
    const setPointerCapture = vi.fn()
    Object.assign(image, { setPointerCapture })
    input.handleRemotePointerDown(pointerEvent({ pointerId: 7 }))

    expect(setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('drops a press whose pointer left the frame instead of replaying it later', async () => {
    const { input, image, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    // Capture is unavailable here (happy-dom), which is exactly when the gesture can end off-frame.
    image.dispatchEvent(new Event('pointerleave'))
    // A later unrelated gesture — begun outside the frame — releases over it.
    input.handleRemotePointerUp(pointerEvent({ clientX: 300, clientY: 260 }))
    await settle()

    expect(calledMethods()).toEqual([])
  })

  it('drops a press left behind by a frame that lost focus', async () => {
    const { input, image, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    image.dispatchEvent(new Event('blur'))
    input.handleRemotePointerUp(pointerEvent({ clientX: 300, clientY: 260 }))
    await settle()

    expect(calledMethods()).toEqual([])
  })

  it('ignores a release from a different pointer and keeps the press for its own', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ pointerId: 4, clientX: 100, clientY: 100 }))
    input.handleRemotePointerUp(pointerEvent({ pointerId: 9, clientX: 300, clientY: 260 }))
    await settle()

    expect(calledMethods()).toEqual([])

    input.handleRemotePointerUp(pointerEvent({ pointerId: 4, clientX: 101, clientY: 101 }))
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseClick'])
  })

  it('does not replay a press older than the age cap', async () => {
    vi.useFakeTimers()
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    // Clock only: a stalled renderer is exactly the case where the hold timer never ran.
    vi.setSystemTime(Date.now() + REMOTE_BROWSER_PRESS_MAX_AGE_MS + 1_000)
    input.handleRemotePointerUp(pointerEvent({ clientX: 101, clientY: 101 }))
    await settle()

    expect(calledMethods()).toEqual([])
  })

  it('keeps a press alive across painted frames', async () => {
    const { input, paintNextFrame, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    paintNextFrame()
    input.handleRemotePointerUp(pointerEvent({ clientX: 101, clientY: 101 }))
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseClick'])
  })

  it('leaves right-button presses to the context-menu path', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ button: 2 }))
    input.handleRemotePointerUp(pointerEvent({ button: 2 }))
    await settle()

    expect(calledMethods()).toEqual([])
  })
})
