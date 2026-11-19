// @vitest-environment happy-dom
// Layout-free DOM: each test places boxes by hand, then moves them the way a drawn older page would.
import { renderHook } from '@testing-library/react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useNativeChatContentAnchor,
  type NativeChatAnchorState
} from './use-native-chat-content-anchor'

const boxes = new Map<Element, { top: number; height: number }>()

function place(element: Element, top: number, height: number): void {
  boxes.set(element, { top, height })
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const { top, height } = boxes.get(this) ?? { top: 0, height: 0 }
    return new DOMRect(0, top, 600, height)
  })
})

afterEach(() => {
  boxes.clear()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const RUN_INDEX = 3
const RUN_SIZE = 600

/** A 400px viewport holding one row: a work run whose header crosses the top edge, then a line. */
function transcript() {
  const container = document.createElement('div')
  const row = document.createElement('div')
  row.setAttribute('data-native-chat-row-key', 'run')
  row.dataset.index = String(RUN_INDEX)
  const header = document.createElement('div')
  header.dataset.nativeChatContentAnchor = 'turn:t1'
  const line = document.createElement('p')
  line.dataset.nativeChatContentAnchor = 'message:kept'
  row.append(header, line)
  container.append(row)
  document.body.append(container)
  container.scrollTop = 500
  place(container, 0, 400)
  // The header crosses the viewport top, so it is the first anchor and the line the fallback.
  place(row, -100, RUN_SIZE)
  place(header, -10, 120)
  place(line, 120, 80)
  return { container, row, header, line }
}

function renderAnchor(container: HTMLDivElement) {
  const anchorState: NativeChatAnchorState = { landing: false, row: null }
  const handedOver: { index: number; size: number; admitted: boolean }[] = []
  const resizeItem = vi.fn((index: number, size: number) => {
    handedOver.push({ index, size, admitted: anchorState.row?.correcting === true })
  })
  const measurementsCache: { size: number }[] = []
  measurementsCache[RUN_INDEX] = { size: RUN_SIZE }
  const reconcileReaderScroll = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the anchor reads only measurementsCache sizes and calls resizeItem.
  const virtualizer = { measurementsCache, resizeItem } as unknown as Virtualizer<
    HTMLDivElement,
    Element
  >
  const { result } = renderHook(() =>
    useNativeChatContentAnchor(
      {
        scrollRef: { current: container },
        isVisible: true,
        virtualizer,
        isAlignHeld: () => false,
        anchorState
      },
      {
        alignToViewportTop: vi.fn(),
        cancelAlign: vi.fn(),
        scrollToEnd: vi.fn(),
        reconcileReaderScroll
      }
    )
  )
  return { anchor: result.current, anchorState, handedOver, reconcileReaderScroll }
}

function snapshotAndPreserve(anchor: ReturnType<typeof renderAnchor>['anchor']): void {
  const snapshot = anchor.snapshotContent()
  expect(snapshot).not.toBeNull()
  anchor.preserveContent(snapshot!)
}

it('hands growth above a partly visible anchor in its row to the virtualizer as that row grows', () => {
  const { container, row, header, line } = transcript()
  const { anchor, handedOver } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  // The page extends the run: 64px of older members draw above the reader's content in the row.
  place(row, -100, RUN_SIZE + 64)
  place(header, 54, 120)
  place(line, 184, 80)
  anchor.reconcileContent()

  expect(handedOver).toEqual([{ index: RUN_INDEX, size: RUN_SIZE + 64, admitted: true }])
})

it('leaves row movement to the virtualizer', () => {
  const { container, row, header, line } = transcript()
  const { anchor, handedOver } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  // The whole row moved (its own page landed above it) but nothing moved inside it.
  place(row, 200, RUN_SIZE)
  place(header, 290, 120)
  place(line, 420, 80)
  anchor.reconcileContent()

  expect(handedOver).toEqual([])
})

it('skips content that moved to another row and holds the next anchor still in place', () => {
  const { container, row, header, line } = transcript()
  const { anchor, handedOver } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  // A split moves the header into a new row; the reader's line stays and gains 40px above it.
  const split = document.createElement('div')
  split.setAttribute('data-native-chat-row-key', 'split')
  split.append(header)
  container.prepend(split)
  place(split, -200, 120)
  place(header, -200, 120)
  place(row, -60, RUN_SIZE)
  place(line, 200, 80)
  anchor.reconcileContent()

  expect(handedOver).toEqual([{ index: RUN_INDEX, size: RUN_SIZE + 40, admitted: true }])
})

it('drops the snapshot once the reader takes over', () => {
  const { container, header } = transcript()
  const { anchor, handedOver, reconcileReaderScroll } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  anchor.reconcileReaderScroll(true)
  expect(reconcileReaderScroll).toHaveBeenCalledWith(true)
  place(header, 54, 120)
  anchor.reconcileContent()

  expect(handedOver).toEqual([])
})

it('marks a page landing from the snapshot until the same commit reconciles', () => {
  const { container } = transcript()
  const { anchor, anchorState } = renderAnchor(container)

  anchor.snapshotContent()
  expect(anchorState.landing).toBe(true)
  anchor.reconcileContent()
  expect(anchorState.landing).toBe(false)
})
