// @vitest-environment happy-dom

// A divider drag must end, commit once and give guests their input back however the gesture is lost.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireWebviewsDragPassthrough,
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from '../browser-pane/host-guest/webview-drag-passthrough'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) })
}))
vi.mock('./TabGroupPanel', () => ({ default: () => null }))

import { ResizeHandle } from './TabGroupSplitNodeTree'

function pointer(
  type: string,
  init: { pointerId?: number; clientX?: number; buttons?: number } = {}
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  Object.defineProperty(event, 'clientX', { value: init.clientX ?? 0 })
  Object.defineProperty(event, 'clientY', { value: 0 })
  Object.defineProperty(event, 'buttons', { value: init.buttons ?? 1 })
  return event
}

describe('tab-group ResizeHandle gesture lifecycle', () => {
  let host: HTMLDivElement
  let root: Root
  let handle: HTMLElement
  let firstPane: HTMLElement
  let otherHandle: HTMLElement
  let otherFirstPane: HTMLElement
  let content: HTMLElement
  let surfaceCalls: boolean[][]
  let unregisterSurfaces: (() => void)[]
  const onRatioChange = vi.fn()
  const onOtherRatioChange = vi.fn()

  const press = (init: { pointerId?: number } = {}) =>
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', init))
    })
  const dispatch = (target: EventTarget, event: Event) =>
    act(() => {
      target.dispatchEvent(event)
    })

  beforeEach(async () => {
    onRatioChange.mockClear()
    onOtherRatioChange.mockClear()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    // Two retained guests, as with two browser groups open beside the divider.
    surfaceCalls = [[], []]
    unregisterSurfaces = surfaceCalls.map((calls) =>
      registerWebviewDragPassthroughSurface((passthrough) => calls.push(passthrough))
    )
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(
        <>
          <div data-split="a">
            <div />
            <ResizeHandle
              direction="horizontal"
              onResizeStart={() => {}}
              onRatioChange={onRatioChange}
            />
            <div />
          </div>
          <div data-split="b">
            <div />
            <ResizeHandle
              direction="horizontal"
              onResizeStart={() => {}}
              onRatioChange={onOtherRatioChange}
            />
            <div />
          </div>
          <p data-content="">Pane content</p>
        </>
      )
    })
    const handles = Array.from(host.querySelectorAll<HTMLElement>('[data-split]')).map((split) => {
      split.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 500)
      const splitHandle = split.querySelector<HTMLElement>('.tab-group-split-resize-handle')!
      splitHandle.setPointerCapture = () => {}
      splitHandle.releasePointerCapture = () => {}
      // Linux Chromium: capture never reports as held while moves keep arriving (#34287).
      splitHandle.hasPointerCapture = () => false
      return { splitHandle, pane: split.querySelector<HTMLElement>(':scope > div')! }
    })
    ;[
      { splitHandle: handle, pane: firstPane },
      { splitHandle: otherHandle, pane: otherFirstPane }
    ] = handles
    content = host.querySelector<HTMLElement>('[data-content]')!
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    for (const unregister of unregisterSurfaces) {
      unregister()
    }
    vi.unstubAllGlobals()
  })

  it('tracks moves when capture is not confirmed and commits once on release', async () => {
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 300 }))
    await dispatch(window, pointer('pointermove', { clientX: 320 }))
    expect(firstPane.style.flex).toBe('0.32 1 0%')

    await dispatch(window, pointer('pointerup', { clientX: 320 }))

    expect(onRatioChange.mock.calls).toEqual([[0.32]])
    expect(surfaceCalls).toEqual([
      [true, false],
      [true, false]
    ])
    expect(isWebviewDragPassthroughActive()).toBe(false)
  })

  it('ends on a buttonless move after a release outside the window', async () => {
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 300 }))
    await dispatch(window, pointer('pointermove', { clientX: 700, buttons: 0 }))
    await dispatch(window, pointer('pointermove', { clientX: 800 }))

    expect(firstPane.style.flex).toBe('0.3 1 0%')
    expect(onRatioChange.mock.calls).toEqual([[0.3]])
    expect(isWebviewDragPassthroughActive()).toBe(false)
  })

  it.each([
    ['window blur', () => window.dispatchEvent(new Event('blur'))],
    [
      'the window being hidden',
      () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        Reflect.deleteProperty(document, 'visibilityState')
      }
    ]
  ])('ends on %s when the release never arrives', async (_name, loseWindow) => {
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 400 }))
    await act(() => loseWindow())
    // A pressed move from a later, unrelated gesture must not resume the lost one.
    await dispatch(window, pointer('pointermove', { clientX: 600 }))
    await dispatch(window, pointer('pointerup', { clientX: 600 }))

    expect(firstPane.style.flex).toBe('0.4 1 0%')
    expect(onRatioChange.mock.calls).toEqual([[0.4]])
    expect(surfaceCalls).toEqual([
      [true, false],
      [true, false]
    ])
  })

  it('lets a new press of the same pointer replace a gesture whose release was missed', async () => {
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 400 }))
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 600 }))
    await dispatch(window, pointer('pointerup', { clientX: 600 }))

    expect(onRatioChange.mock.calls).toEqual([[0.4], [0.6]])
    expect(isWebviewDragPassthroughActive()).toBe(false)
  })

  it('ends a lost gesture when the same pointer presses another divider', async () => {
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 300 }))
    await dispatch(otherHandle, pointer('pointerdown'))
    await dispatch(window, pointer('pointermove', { clientX: 600 }))
    await dispatch(window, pointer('pointerup', { clientX: 600 }))

    expect(firstPane.style.flex).toBe('0.3 1 0%')
    expect(otherFirstPane.style.flex).toBe('0.6 1 0%')
    expect(onRatioChange.mock.calls).toEqual([[0.3]])
    expect(onOtherRatioChange.mock.calls).toEqual([[0.6]])
    expect(isWebviewDragPassthroughActive()).toBe(false)
  })

  it('ends a lost gesture when the same pointer presses ordinary content', async () => {
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 300 }))
    await dispatch(content, pointer('pointerdown'))
    await dispatch(window, pointer('pointermove', { clientX: 600 }))
    await dispatch(window, pointer('pointerup', { clientX: 600 }))

    expect(firstPane.style.flex).toBe('0.3 1 0%')
    expect(onRatioChange.mock.calls).toEqual([[0.3]])
    expect(surfaceCalls).toEqual([
      [true, false],
      [true, false]
    ])
  })

  it('keeps another drag owner click-through after the divider releases', async () => {
    const releaseTabDrag = acquireWebviewsDragPassthrough()
    await press()
    await dispatch(window, pointer('pointerup', { clientX: 400 }))
    expect(isWebviewDragPassthroughActive()).toBe(true)
    expect(surfaceCalls.map((calls) => calls.at(-1))).toEqual([true, true])

    releaseTabDrag()
    expect(isWebviewDragPassthroughActive()).toBe(false)
    expect(surfaceCalls.map((calls) => calls.at(-1))).toEqual([false, false])
  })

  it('ignores a second pointer while the first one drags', async () => {
    await press({ pointerId: 1 })
    await press({ pointerId: 2 })
    await dispatch(content, pointer('pointerdown', { pointerId: 2 }))
    await dispatch(otherHandle, pointer('pointerdown', { pointerId: 2 }))
    await dispatch(window, pointer('pointerup', { pointerId: 2 }))
    await dispatch(window, pointer('pointermove', { pointerId: 2, clientX: 700 }))
    await dispatch(window, pointer('pointermove', { pointerId: 1, clientX: 250 }))
    await dispatch(window, pointer('pointerup', { pointerId: 2 }))

    expect(firstPane.style.flex).toBe('0.25 1 0%')
    expect(onRatioChange).not.toHaveBeenCalled()
    expect(isWebviewDragPassthroughActive()).toBe(true)

    await dispatch(window, pointer('pointerup', { pointerId: 1 }))
    expect(onRatioChange.mock.calls).toEqual([[0.25]])
    expect(isWebviewDragPassthroughActive()).toBe(false)
  })

  it('releases passthrough exactly once when unmounted mid-drag', async () => {
    await press()
    await dispatch(window, pointer('pointermove', { clientX: 450 }))
    await act(async () => root.unmount())
    window.dispatchEvent(new Event('blur'))

    expect(onRatioChange.mock.calls).toEqual([[0.45]])
    expect(surfaceCalls).toEqual([
      [true, false],
      [true, false]
    ])
    root = createRoot(host)
  })
})
