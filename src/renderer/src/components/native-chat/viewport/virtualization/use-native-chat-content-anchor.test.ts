// @vitest-environment happy-dom
// Layout-free DOM: each test places boxes by hand, then moves them the way a drawn older page would.
import { renderHook } from '@testing-library/react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatContentAnchor } from './use-native-chat-content-anchor'

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

/** A 400px viewport at the top of the page holding one row: a work run with two readable lines. */
function transcript() {
  const container = document.createElement('div')
  const row = document.createElement('div')
  row.setAttribute('data-native-chat-row-key', 'run')
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
  place(row, -100, 600)
  place(header, -10, 120)
  place(line, 120, 80)
  return { container, row, header, line }
}

function renderAnchor(container: HTMLDivElement) {
  const scrollToOffset = vi.fn()
  const reconcileReaderScroll = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the anchor calls only scrollToOffset on the virtualizer.
  const virtualizer = { scrollToOffset } as unknown as Virtualizer<HTMLDivElement, Element>
  const { result } = renderHook(() =>
    useNativeChatContentAnchor(
      {
        scrollRef: { current: container },
        isVisible: true,
        virtualizer,
        isAlignHeld: () => false
      },
      {
        alignToViewportTop: vi.fn(),
        cancelAlign: vi.fn(),
        scrollToEnd: vi.fn(),
        reconcileReaderScroll
      }
    )
  )
  return { anchor: result.current, scrollToOffset, reconcileReaderScroll }
}

function snapshotAndPreserve(anchor: ReturnType<typeof renderAnchor>['anchor']): void {
  const snapshot = anchor.snapshotContent()
  expect(snapshot).not.toBeNull()
  anchor.preserveContent(snapshot!)
}

it('scrolls by the growth above the reader inside its own row', () => {
  const { container, row, header, line } = transcript()
  const { anchor, scrollToOffset } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  // The page extends the run: 64px of older members draw above the reader's content in the same row.
  place(row, -100, 664)
  place(header, 54, 120)
  place(line, 184, 80)
  anchor.reconcileContent()

  expect(scrollToOffset).toHaveBeenCalledTimes(1)
  expect(scrollToOffset).toHaveBeenCalledWith(564, { behavior: 'auto' })
})

it('leaves row movement to the virtualizer', () => {
  const { container, row, header, line } = transcript()
  const { anchor, scrollToOffset } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  // The whole row moved (its own page landed above it) but nothing moved inside it.
  place(row, 200, 600)
  place(header, 290, 120)
  place(line, 420, 80)
  anchor.reconcileContent()

  expect(scrollToOffset).not.toHaveBeenCalled()
})

it('skips content that moved to another row and holds the next anchor still in place', () => {
  const { container, row, header, line } = transcript()
  const { anchor, scrollToOffset } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  // A split moves the header into a new row; the reader's line stays and gains 40px above it.
  const split = document.createElement('div')
  split.setAttribute('data-native-chat-row-key', 'split')
  split.append(header)
  container.prepend(split)
  place(split, -200, 120)
  place(header, -200, 120)
  place(row, -60, 600)
  place(line, 200, 80)
  anchor.reconcileContent()

  expect(scrollToOffset).toHaveBeenCalledWith(540, { behavior: 'auto' })
})

it('drops the snapshot once the reader takes over', () => {
  const { container, header } = transcript()
  const { anchor, scrollToOffset, reconcileReaderScroll } = renderAnchor(container)
  snapshotAndPreserve(anchor)

  anchor.reconcileReaderScroll(true)
  expect(reconcileReaderScroll).toHaveBeenCalledWith(true)
  place(header, 54, 120)
  anchor.reconcileContent()

  expect(scrollToOffset).not.toHaveBeenCalled()
})
