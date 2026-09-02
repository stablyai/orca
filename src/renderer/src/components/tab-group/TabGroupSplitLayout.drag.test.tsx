// @vitest-environment happy-dom

// Why: the sibling TabGroupSplitLayout.test.ts calls components as plain
// functions and cannot exercise the drag gesture; these tests real-render the
// handle to pin the STA-3328 contract — pointermove writes pane styles
// directly and the store is committed exactly once, on release.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const setTabGroupSplitRatioMock = vi.fn()
const recordFeatureInteractionMock = vi.fn()

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      recordFeatureInteraction: recordFeatureInteractionMock,
      setTabGroupSplitRatio: setTabGroupSplitRatioMock
    })
}))

vi.mock('./TabGroupPanel', () => ({
  default: ({ groupId }: { groupId: string }) => <div data-testid={`panel-${groupId}`} />
}))

vi.mock('./useTabDragSplit', () => ({
  useTabDragSplit: () => ({
    activeDrag: null,
    collisionDetection: vi.fn(),
    hoveredDropTarget: null,
    hoveredTabInsertion: null,
    isTabDragActiveRef: { current: false },
    onDragCancel: vi.fn(),
    onDragEnd: vi.fn(),
    onDragMove: vi.fn(),
    onDragOver: vi.fn(),
    onDragStart: vi.fn(),
    sensors: [],
    setDragRootNode: vi.fn()
  })
}))

import TabGroupSplitLayout from './TabGroupSplitLayout'

function pointerEvent(type: string, init: { pointerId?: number; clientX?: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  Object.defineProperty(event, 'clientX', { value: init.clientX ?? 0 })
  Object.defineProperty(event, 'clientY', { value: 0 })
  return event
}

describe('TabGroupSplitLayout divider drag', () => {
  let container: HTMLDivElement
  let root: Root | null
  let handle: HTMLElement
  let firstPane: HTMLElement
  let secondPane: HTMLElement
  let containerRect: DOMRect
  let resizeObserverCallback: ResizeObserverCallback | null
  const resizeObserverDisconnectMock = vi.fn()

  beforeEach(async () => {
    setTabGroupSplitRatioMock.mockClear()
    recordFeatureInteractionMock.mockClear()
    resizeObserverDisconnectMock.mockClear()
    resizeObserverCallback = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: ResizeObserverCallback
        private tracksSplitContainer = false

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback
        }

        observe(target: Element): void {
          if (target === handle?.parentElement) {
            this.tracksSplitContainer = true
            resizeObserverCallback = this.callback
          }
        }
        unobserve(): void {}
        disconnect(): void {
          if (this.tracksSplitContainer) {
            resizeObserverDisconnectMock()
          }
        }
      }
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    const mountedRoot = createRoot(container)
    root = mountedRoot
    await act(async () => {
      mountedRoot.render(
        <TabGroupSplitLayout
          layout={{
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', groupId: 'left-group' },
            second: { type: 'leaf', groupId: 'right-group' }
          }}
          worktreeId="wt-1"
          focusedGroupId="right-group"
          isWorktreeActive={true}
        />
      )
    })
    handle = container.querySelector('.tab-group-split-resize-handle') as HTMLElement
    expect(handle).not.toBeNull()
    firstPane = handle.previousElementSibling as HTMLElement
    secondPane = handle.nextElementSibling as HTMLElement
    const capturedPointers = new Set<number>()
    Object.assign(handle, {
      setPointerCapture: (pointerId: number) => {
        capturedPointers.add(pointerId)
      },
      releasePointerCapture: (pointerId: number) => {
        capturedPointers.delete(pointerId)
      },
      hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId)
    })
    const splitContainer = handle.parentElement as HTMLElement
    containerRect = {
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
      right: 1000,
      bottom: 500
    } as DOMRect
    splitContainer.getBoundingClientRect = vi.fn(() => containerRect)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('writes pane styles per move and commits the store once on release', async () => {
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
    })
    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('terminal-panes')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 300 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 320 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 340 }))
    })

    // Why: the drag must never publish store updates per move (STA-3328) —
    // the panes track the pointer via direct style writes instead.
    expect(setTabGroupSplitRatioMock).not.toHaveBeenCalled()
    expect(firstPane.style.flex).toBe('0.34 1 0%')
    expect(secondPane.style.flex).toBe('0.66 1 0%')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }))
    })
    expect(setTabGroupSplitRatioMock).toHaveBeenCalledTimes(1)
    expect(setTabGroupSplitRatioMock).toHaveBeenCalledWith('wt-1', '', 0.34)
  })

  it('clamps the committed ratio and skips the commit when nothing moved', async () => {
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }))
    })
    expect(setTabGroupSplitRatioMock).not.toHaveBeenCalled()

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 20 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }))
    })
    expect(setTabGroupSplitRatioMock).toHaveBeenCalledTimes(1)
    expect(setTabGroupSplitRatioMock).toHaveBeenCalledWith('wt-1', '', 0.15)
  })

  it('refreshes drag geometry only when the split container resizes', async () => {
    const getRectMock = handle.parentElement?.getBoundingClientRect as ReturnType<typeof vi.fn>
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 250 }))
    })
    expect(firstPane.style.flex).toBe('0.25 1 0%')
    expect(getRectMock).toHaveBeenCalledOnce()

    containerRect = { ...containerRect, width: 500, right: 500 } as DOMRect
    resizeObserverCallback?.([], {} as ResizeObserver)
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 250 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }))
    })

    expect(firstPane.style.flex).toBe('0.5 1 0%')
    expect(getRectMock).toHaveBeenCalledTimes(2)
    expect(setTabGroupSplitRatioMock).toHaveBeenCalledWith('wt-1', '', 0.5)
    expect(resizeObserverDisconnectMock).toHaveBeenCalledOnce()
  })

  it('ignores events from pointers that do not own the drag', async () => {
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 350 }))
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 300 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 2 }))
    })
    expect(firstPane.style.flex).toBe('0.35 1 0%')
    expect(setTabGroupSplitRatioMock).not.toHaveBeenCalled()

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }))
    })
    expect(setTabGroupSplitRatioMock).toHaveBeenCalledWith('wt-1', '', 0.35)
  })

  it.each(['pointercancel', 'lostpointercapture'])('commits on %s', async (eventType) => {
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 400 }))
      handle.dispatchEvent(pointerEvent(eventType, { pointerId: 1 }))
    })
    expect(setTabGroupSplitRatioMock).toHaveBeenCalledWith('wt-1', '', 0.4)
    expect(resizeObserverDisconnectMock).toHaveBeenCalledOnce()
  })

  it('commits and releases drag resources on unmount', async () => {
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 450 }))
    })
    act(() => root?.unmount())
    root = null

    expect(setTabGroupSplitRatioMock).toHaveBeenCalledWith('wt-1', '', 0.45)
    expect(resizeObserverDisconnectMock).toHaveBeenCalledOnce()
  })
})
