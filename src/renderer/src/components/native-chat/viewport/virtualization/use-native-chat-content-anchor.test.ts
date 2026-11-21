// @vitest-environment happy-dom
// A real virtualizer over a layout-free DOM: each test places boxes by hand, then grows or moves
// them the way a drawn older page would, and checks the virtualizer's cache, offset and layout.
import { renderHook } from '@testing-library/react'
import { elementScroll, Virtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useNativeChatContentAnchor,
  type NativeChatAnchorState
} from './use-native-chat-content-anchor'

const boxes = new Map<Element, { top: number; height: number }>()
const observers: FakeResizeObserver[] = []

function place(element: Element, top: number, height: number): void {
  boxes.set(element, { top, height })
}

/** Resize delivery is driven by each test, so both observer orderings can be exercised. */
class FakeResizeObserver {
  readonly targets = new Set<Element>()
  constructor(private readonly callback: () => void) {
    observers.push(this)
  }
  observe(target: Element): void {
    this.targets.add(target)
  }
  unobserve(target: Element): void {
    this.targets.delete(target)
  }
  disconnect(): void {
    this.targets.clear()
  }
  deliver(): void {
    this.callback()
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const { top, height } = boxes.get(this) ?? { top: 0, height: 0 }
    return new DOMRect(0, top, 600, height)
  })
})

afterEach(() => {
  boxes.clear()
  observers.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const ROW_SIZE = 100
const RUN_INDEX = 2
const RUN_SIZE = 600
const START_OFFSET = 500

/** Five rows; the third is a 600px work run whose header crosses the 400px viewport's top. */
function transcript() {
  const container = document.createElement('div')
  const rows = Array.from({ length: 5 }, (_, index) => {
    const row = document.createElement('div')
    row.dataset.index = String(index)
    row.setAttribute('data-native-chat-row-key', `row-${index}`)
    container.append(row)
    place(row, 0, index === RUN_INDEX ? RUN_SIZE : ROW_SIZE)
    return row
  })
  const run = rows[RUN_INDEX]!
  const header = document.createElement('div')
  header.dataset.nativeChatContentAnchor = 'tool:call:a'
  const line = document.createElement('p')
  line.dataset.nativeChatContentAnchor = 'tool:call:b'
  run.append(header, line)
  document.body.append(container)
  container.scrollTop = START_OFFSET
  place(container, 0, 400)
  // The run starts at 200, so at offset 500 its top is 300px above the viewport.
  place(run, -300, RUN_SIZE)
  place(header, -10, 120)
  place(line, 120, 80)
  return { container, rows, run, header, line }
}

function anchorWith(container: HTMLDivElement, rows: HTMLDivElement[]) {
  const anchorState: NativeChatAnchorState = { landing: false, row: null }
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: rows.length,
    getScrollElement: () => container,
    // Estimates match the drawn rows, so registering them moves nothing.
    estimateSize: (index) => (index === RUN_INDEX ? RUN_SIZE : ROW_SIZE),
    getItemKey: (index) => `row-${index}`,
    scrollToFn: elementScroll,
    observeElementRect: (_instance, callback) => callback({ width: 600, height: 400 }),
    observeElementOffset: (_instance, callback) => callback(container.scrollTop, false),
    measureElement: (element) => boxes.get(element)?.height ?? 0
  })
  // The transcript window's rule: the anchored row moves the scroll only for its handed-over change.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
    anchorState.row?.key === item.key
      ? anchorState.row.correcting
      : item.end <= (virtualizer.scrollOffset ?? 0)
  virtualizer._didMount()
  virtualizer._willUpdate()
  for (const row of rows) {
    virtualizer.measureElement(row)
  }
  const reconcileReaderScroll = vi.fn()
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
  const anchor = result.current
  const snapshot = anchor.snapshotContent()
  expect(snapshot).not.toBeNull()
  anchor.preserveContent(snapshot!)
  return { anchor, virtualizer, reconcileReaderScroll }
}

/** The anchor's own observer: the one created after the virtualizer's, watching the run row. */
function anchorObserver(run: HTMLDivElement): FakeResizeObserver {
  const observer = observers.findLast((candidate) => candidate.targets.has(run))
  if (!observer) {
    throw new Error('The anchor is not watching its row')
  }
  return observer
}

/** Leave the row's range and come back, then read the layout the window would draw from. */
function layoutAfterReturning(virtualizer: Virtualizer<HTMLDivElement, Element>) {
  virtualizer.scrollToOffset(0)
  virtualizer.scrollToOffset(START_OFFSET)
  return virtualizer.getVirtualItems().map(({ start, size }) => ({ start, size }))
}

it.each(['virtualizer first', 'anchor first'] as const)(
  'counts late growth above a partly visible anchor once when the %s sees it',
  (order) => {
    const { container, rows, run, header, line } = transcript()
    const { anchor, virtualizer } = anchorWith(container, rows)
    anchor.reconcileContent()
    expect(container.scrollTop).toBe(START_OFFSET)

    // A late measurement grows the run by 64px above the header the reader is looking at.
    place(run, -300, RUN_SIZE + 64)
    place(header, 54, 120)
    place(line, 184, 80)
    if (order === 'virtualizer first') {
      virtualizer.measureElement(run)
      anchorObserver(run).deliver()
    } else {
      anchorObserver(run).deliver()
      virtualizer.measureElement(run)
    }

    expect(container.scrollTop).toBe(START_OFFSET + 64)
    expect(virtualizer.itemSizeCache.get(`row-${RUN_INDEX}`)).toBe(RUN_SIZE + 64)
    expect(virtualizer.getTotalSize()).toBe(4 * ROW_SIZE + RUN_SIZE + 64)
    // Rows after the run start where the run really ends: no phantom gap once redrawn.
    const layout = layoutAfterReturning(virtualizer)
    for (const [position, item] of layout.slice(1).entries()) {
      expect(item.start).toBe(layout[position]!.start + layout[position]!.size)
    }
    expect(layout.find(({ size }) => size === RUN_SIZE + 64)).toBeDefined()
  }
)

it('leaves row movement to the virtualizer', () => {
  const { container, rows, run, header, line } = transcript()
  const { anchor } = anchorWith(container, rows)

  // The whole row moved (rows landed above it) but nothing moved inside it.
  place(run, -100, RUN_SIZE)
  place(header, 190, 120)
  place(line, 320, 80)
  anchor.reconcileContent()

  expect(container.scrollTop).toBe(START_OFFSET)
})

it('skips content that moved to another row and holds the next anchor still in place', () => {
  const { container, rows, run, header, line } = transcript()
  const { anchor, virtualizer } = anchorWith(container, rows)

  // A split moves the header into the row above; the line stays in the run and gains 40px above it.
  rows[RUN_INDEX - 1]!.append(header)
  place(header, -200, 120)
  place(run, -300, RUN_SIZE + 40)
  place(line, 160, 80)
  anchor.reconcileContent()

  expect(container.scrollTop).toBe(START_OFFSET + 40)
  expect(virtualizer.itemSizeCache.get(`row-${RUN_INDEX}`)).toBe(RUN_SIZE + 40)
})

it('drops the snapshot once the reader takes over', () => {
  const { container, rows, run, header } = transcript()
  const { anchor, reconcileReaderScroll } = renderAnchorAndTakeOver(container, rows)

  expect(reconcileReaderScroll).toHaveBeenCalledWith(true)
  place(run, -300, RUN_SIZE + 64)
  place(header, 54, 120)
  anchor.reconcileContent()

  expect(container.scrollTop).toBe(START_OFFSET)
})

function renderAnchorAndTakeOver(container: HTMLDivElement, rows: HTMLDivElement[]) {
  const anchored = anchorWith(container, rows)
  anchored.anchor.reconcileReaderScroll(true)
  return anchored
}
