// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'
import {
  estimateNativeChatRowHeight,
  NATIVE_CHAT_ROW_GAP_PX,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

afterEach(cleanup)

const VIEWPORT_PX = 600
const TRANSCRIPT_LENGTH = 200

/** Everything the document holds below the last row: the transcript column's
 *  trailing chrome and the scroll root's bottom padding. Non-zero on purpose —
 *  the document's bottom sits past the window's last row, which is exactly where
 *  a pin computed from the virtualizer's totals and one computed from the
 *  document disagree. */
const BELOW_TRANSCRIPT_PX = 24

/** Heights the stubbed layout reports per row index, when a case wants a row to
 *  measure as something other than its estimate. Empty means "every row at its
 *  estimate", which is what every non-growth case wants. */
let measuredRowHeights: readonly number[] = []

function marker(index: number): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: `marker-${index}` }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

const ROW_PX = estimateNativeChatRowHeight(nativeChatRowContentMetrics(marker(0)), {
  hasReceipt: false,
  hasStatus: false,
  hasTurnDiff: false
})
const ROW_PITCH_PX = ROW_PX + NATIVE_CHAT_ROW_GAP_PX

/** Replace a layout property on every element, and hand back the undo. */
function overrideLayoutProperty(name: string, descriptor: PropertyDescriptor): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, name, original)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name)
    }
  }
}

/** The spacer's reserved height, which is the transcript's whole rendered height:
 *  windowed rows are absolutely positioned inside it, so a row growing in place
 *  reaches the document only through the height the window reserves for it. */
function reservedTranscriptHeight(root: ParentNode): number {
  const spacer = root.querySelector<HTMLElement>('[data-native-chat-window]')
  return spacer ? Number.parseFloat(spacer.style.height) || 0 : 0
}

// The virtualizer measures with `offsetHeight` — not `clientHeight`, not a
// bounding rect — so that is the one thing a DOM without layout has to answer
// for windowing to engage at all. Rows report the height their own estimate
// predicted, which keeps the totals exact and independent of which rows happen
// to have been mounted long enough to be measured; `measuredRowHeights` is how a
// case says a row measures as something else.
//
// `scrollGeometry` additionally gives the scroll root a document to scroll: a
// height, a viewport, and a `scrollTop` that clamps the way a real one does.
// Off by default, because a transcript with a real document opens pinned to its
// bottom and the cases above are about where the window sits, not where it lands.
function stubLayout({ scrollGeometry = false } = {}): () => void {
  const scrollTops = new WeakMap<HTMLElement, number>()
  const restores = [
    overrideLayoutProperty('offsetHeight', {
      get(this: HTMLElement): number {
        if (this.hasAttribute('data-native-chat-scroll')) {
          return VIEWPORT_PX
        }
        if (this.hasAttribute('data-native-chat-window')) {
          return reservedTranscriptHeight(this.parentElement ?? this)
        }
        const index = this.dataset.index
        if (index !== undefined) {
          return measuredRowHeights[Number(index)] ?? ROW_PX
        }
        // The transcript column: as tall as the window it wraps, plus what sits
        // under it. This is the element the list observes for streamed growth.
        return this.classList.contains('max-w-4xl')
          ? reservedTranscriptHeight(this) + BELOW_TRANSCRIPT_PX
          : 0
      }
    })
  ]
  if (scrollGeometry) {
    restores.push(
      overrideLayoutProperty('clientHeight', {
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-chat-scroll') ? VIEWPORT_PX : 0
        }
      }),
      overrideLayoutProperty('scrollHeight', {
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-chat-scroll')
            ? reservedTranscriptHeight(this) + BELOW_TRANSCRIPT_PX
            : 0
        }
      }),
      overrideLayoutProperty('scrollTop', {
        get(this: HTMLElement): number {
          return scrollTops.get(this) ?? 0
        },
        set(this: HTMLElement, value: number): void {
          // A browser clamps; without this `scrollTop = scrollHeight` would park
          // the view past the end and every distance-from-bottom would read 0.
          const max = Math.max(0, this.scrollHeight - this.clientHeight)
          scrollTops.set(this, Math.min(Math.max(0, value), max))
        }
      })
    )
  }
  return () => {
    for (const restore of restores.toReversed()) {
      restore()
    }
  }
}

type FakeResizeObservation = {
  callback: ResizeObserverCallback
  /** Target -> height last delivered. -1 means "never", so the first flush
   *  delivers, the way a real observer's initial callback does. */
  observed: Map<Element, number>
}

const resizeObservations = new Set<FakeResizeObservation>()

/** happy-dom's ResizeObserver never fires, so nothing that re-measures ever runs.
 *  This one records what production observes and delivers only when a target's
 *  height actually changed — the browser's own rule — and only when a test says
 *  a frame was painted. Entries carry no `borderBoxSize`, so the virtualizer
 *  falls back to `offsetHeight`, which is the path being modelled. */
function stubResizeObserver(): () => void {
  const original = window.ResizeObserver
  class TestResizeObserver {
    private readonly observation: FakeResizeObservation
    constructor(callback: ResizeObserverCallback) {
      this.observation = { callback, observed: new Map() }
      resizeObservations.add(this.observation)
    }
    observe(target: Element): void {
      this.observation.observed.set(target, -1)
    }
    unobserve(target: Element): void {
      this.observation.observed.delete(target)
    }
    disconnect(): void {
      this.observation.observed.clear()
      resizeObservations.delete(this.observation)
    }
  }
  window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
  return () => {
    resizeObservations.clear()
    window.ResizeObserver = original
  }
}

/** Deliver one round of resize callbacks; true when anything was delivered. */
function deliverResizes(): boolean {
  let delivered = false
  // A copy: a callback may disconnect its own observer mid-delivery.
  for (const observation of Array.from(resizeObservations)) {
    const entries: ResizeObserverEntry[] = []
    for (const [target, lastHeight] of observation.observed) {
      const height = (target as HTMLElement).offsetHeight
      if (height !== lastHeight) {
        observation.observed.set(target, height)
        entries.push({ target } as unknown as ResizeObserverEntry)
      }
    }
    if (entries.length > 0) {
      delivered = true
      observation.callback(entries, undefined as unknown as ResizeObserver)
    }
  }
  return delivered
}

function session(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

function list(messages: NativeChatMessage[]): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={session(messages)}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

/** Reads the window, and refuses to pass if there is no window to read.
 *
 *  Without this a change to the usability gate would quietly send every case
 *  below down the whole-transcript path, where "fewer rows than messages" is
 *  false but every other assertion still holds. */
function windowState(container: HTMLElement): { totalSize: number; indexes: number[] } {
  const spacer = container.querySelector<HTMLElement>('[data-native-chat-window]')
  if (!spacer) {
    throw new Error('transcript is not windowed: no spacer, every row is mounted')
  }
  const totalSize = Number.parseFloat(spacer.style.height)
  if (!(totalSize > 0)) {
    throw new Error(`transcript reserved no height (${spacer.style.height})`)
  }
  return {
    totalSize,
    indexes: Array.from(container.querySelectorAll<HTMLElement>('[data-index]'))
      .map((row) => Number(row.dataset.index))
      .sort((left, right) => left - right)
  }
}

/** happy-dom fires no scroll event for an assignment to `scrollTop`. */
function scrollTranscript(container: HTMLElement, top: number): void {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

describe('windowed transcript', () => {
  let restoreLayout = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    restoreLayout()
  })

  const transcript = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => marker(index))

  it('mounts a window over the transcript rather than all of it', () => {
    const { container } = render(list(transcript))
    const { indexes } = windowState(container)

    expect(indexes.length).toBeGreaterThan(0)
    expect(indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    expect(indexes).toContain(0)
    expect(screen.getByText('marker-0')).toBeInTheDocument()
    expect(screen.queryByText(`marker-${TRANSCRIPT_LENGTH - 2}`)).toBeNull()
  })

  // One gap per pair of rows, and none after the last one. The other half of
  // this — that a row's own reservation does not include the gap as well — is
  // pinned on the estimate itself, where it can be seen without layout.
  it('reserves each row once and one gap between each pair', () => {
    const { container } = render(list(transcript))

    expect(windowState(container).totalSize).toBe(
      TRANSCRIPT_LENGTH * ROW_PX + (TRANSCRIPT_LENGTH - 1) * NATIVE_CHAT_ROW_GAP_PX
    )
  })

  it('moves the mounted rows to bracket the offset the reader scrolled to', () => {
    const { container } = render(list(transcript))
    const offset = 5000
    scrollTranscript(container, offset)
    const { indexes } = windowState(container)
    const focused = Math.floor(offset / ROW_PITCH_PX)

    expect(indexes).toContain(focused)
    expect(indexes[0]).toBeLessThanOrEqual(focused)
    expect(indexes.at(-1)).toBeGreaterThanOrEqual(focused)
    expect(indexes).not.toContain(0)
    expect(indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
  })

  // The live row announces a running tool through `aria-live`, which says nothing
  // from a row that is not in the document.
  it('keeps the newest row mounted after the reader scrolls away from it', () => {
    const { container } = render(list(transcript))
    scrollTranscript(container, 5000)

    expect(windowState(container).indexes).toContain(TRANSCRIPT_LENGTH - 1)
  })

  it('gives no slot to a message that draws nothing', () => {
    const withBlanks = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      index % 4 === 0
        ? { ...marker(index), blocks: [{ type: 'text' as const, text: '' }] }
        : marker(index)
    )
    const drawn = TRANSCRIPT_LENGTH - TRANSCRIPT_LENGTH / 4
    const { container } = render(list(withBlanks))
    const { totalSize, indexes } = windowState(container)

    expect(totalSize).toBe(drawn * ROW_PX + (drawn - 1) * NATIVE_CHAT_ROW_GAP_PX)
    expect(indexes.at(-1)).toBeLessThanOrEqual(drawn - 1)
  })

  it('still has the tool run open when the row carrying it comes back', () => {
    const withTool = [...transcript]
    withTool[1] = {
      ...marker(1),
      blocks: [
        { type: 'text', text: 'marker-1' },
        { type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }
      ]
    }
    const { container } = render(list(withTool))

    const header = screen.getByRole('button', { name: /1×/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    expect(screen.getByRole('button', { name: /1×/ })).toHaveAttribute('aria-expanded', 'true')

    scrollTranscript(container, 5000)
    expect(windowState(container).indexes).not.toContain(1)
    expect(screen.queryByRole('button', { name: /1×/ })).toBeNull()

    scrollTranscript(container, 0)
    expect(screen.getByRole('button', { name: /1×/ })).toHaveAttribute('aria-expanded', 'true')
  })
})

// The reveal chain runs message -> tool run -> diff card and lands on a card in
// a DIFFERENT, earlier message than the rollup that was clicked. Under windowing
// that message may not be mounted to be pointed at, so the reveal names it by id
// and the row is pinned into the window until the card can answer for itself.
describe('revealing a diff from a turn rollup', () => {
  let restoreLayout = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    restoreLayout()
    vi.restoreAllMocks()
  })

  function journalItem(itemId: string, body: AgentJournalItemBody, sequence: number) {
    return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1 }
  }

  const patch = '@@ -1 +1 @@\n-before\n+after'
  const items: AgentJournalRenderItem[] = [
    journalItem(
      'user',
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Edit it' }] },
      1
    ),
    journalItem(
      'diff',
      {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
      },
      2
    ),
    ...Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      journalItem(
        `tail-${index}`,
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `marker-${index}` }] },
        index + 3
      )
    )
  ]

  it('mounts the row a reveal names even when the window has left it behind', () => {
    const scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    const { container } = render(
      <NativeChatMessageList
        session={session(projectStructuredItemsToNativeChat(items))}
        journalItems={items}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
    // The rollup rides the turn's last row, which is pinned; the diff it points
    // at is near the top and long gone from the window.
    scrollTranscript(container, 4000)
    expect(screen.queryByText('Edited file')).toBeNull()
    const mountedBefore = windowState(container).indexes.length

    fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
    scrollTo.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))

    expect(screen.getByText('Edited file')).toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
    expect(scrollTo).toHaveBeenCalled()
    // Pinned, not paged to: the window is still a window.
    expect(windowState(container).indexes.length).toBeLessThanOrEqual(mountedBefore + 2)
  })
})

describe('transcript with no usable scroll root', () => {
  const transcript = Array.from({ length: 40 }, (_, index) => marker(index))

  // Not a degraded mode: this is what runs whenever the scroll root cannot say
  // where the viewport is, and it has to render exactly what the list rendered
  // before windowing existed.
  it('falls back to mounting every row, with no spacer between them and the column', () => {
    const { container } = render(list(transcript))

    expect(container.querySelector('[data-native-chat-window]')).toBeNull()
    expect(container.querySelectorAll('[data-index]')).toHaveLength(0)
    expect(screen.getAllByText(/^marker-/)).toHaveLength(40)
    const column = container.querySelector('.max-w-4xl')
    expect(column?.children).toHaveLength(40)
  })
})

// A row that grows in place: the same message id, more content, a taller measured
// box — what a streaming reply looks like to the window. Whole-message appends
// arrive at their final height and are a different case; this is the one where
// the row the reader is looking at keeps changing size underneath them.
//
// Two mechanisms are supposed to hold the pin, and both are exercised here: the
// list's own resize observer on the transcript column (which re-runs
// `scrollToBottom` against the document) and the virtualizer's end anchor (which
// compensates `scrollTop` by the growth when the view was already at the end).
describe('a row growing in place while the view is pinned to the bottom', () => {
  const TAIL_INDEX = TRANSCRIPT_LENGTH - 1
  const GROWTH_STEPS = 24
  const LINES_PER_STEP = 12
  /** One wrapped prose line. Content and measured height grow from this one
   *  number, so a step that adds lines is a step that adds pixels. */
  const STREAM_LINE_PX = 22
  /** Every row but the growing one measures at its estimate, so the reserved
   *  total is arithmetic rather than a snapshot. */
  const BASE_TOTAL_PX =
    (TRANSCRIPT_LENGTH - 1) * ROW_PX + (TRANSCRIPT_LENGTH - 1) * NATIVE_CHAT_ROW_GAP_PX

  /** Fixed so a re-render never restamps the turn and moves the status row. */
  const TURN_STARTED_AT = Date.now()

  const transcript = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => marker(index))

  function tailHeightAt(step: number): number {
    return Math.max(ROW_PX, (1 + step * LINES_PER_STEP) * STREAM_LINE_PX)
  }

  function transcriptAt(step: number): NativeChatMessage[] {
    const lines = Array.from(
      { length: step * LINES_PER_STEP },
      (_, index) => `streamed line ${index}`
    )
    const next = [...transcript]
    next[TAIL_INDEX] = {
      ...marker(TAIL_INDEX),
      blocks: [{ type: 'text', text: [`marker-${TAIL_INDEX}`, ...lines].join('\n') }]
    }
    return next
  }

  function streamingList(step: number): React.JSX.Element {
    return (
      <NativeChatMessageList
        session={session(transcriptAt(step))}
        isWorking
        expandSignal={false}
        fontScale={1}
        workingStartedAt={TURN_STARTED_AT}
      />
    )
  }

  function scrollRoot(container: HTMLElement): HTMLElement {
    const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
    if (!scroller) {
      throw new Error('no transcript scroll root')
    }
    return scroller
  }

  /** One painted frame, repeated to a fixed point: deliver the resize callbacks
   *  the growth caused, then fire the scroll event a browser fires for any
   *  `scrollTop` the code wrote itself. Refusing to settle is a failure in its
   *  own right — that is the view oscillating. */
  function paint(container: HTMLElement): void {
    const scroller = scrollRoot(container)
    let lastScrollTop = scroller.scrollTop
    for (let pass = 0; pass < 12; pass += 1) {
      let changed = false
      act(() => {
        changed = deliverResizes()
      })
      if (scroller.scrollTop !== lastScrollTop) {
        lastScrollTop = scroller.scrollTop
        fireEvent.scroll(scroller)
        changed = true
      }
      if (!changed) {
        return
      }
    }
    throw new Error('the transcript never settled: resize and scroll kept moving it')
  }

  function distanceFromBottom(container: HTMLElement): number {
    const scroller = scrollRoot(container)
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
  }

  function setMeasuredTail(step: number): void {
    const heights = Array.from({ length: TRANSCRIPT_LENGTH }, () => ROW_PX)
    heights[TAIL_INDEX] = tailHeightAt(step)
    measuredRowHeights = heights
  }

  let restoreLayout = (): void => {}
  let restoreResizeObserver = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout({ scrollGeometry: true })
    restoreResizeObserver = stubResizeObserver()
    setMeasuredTail(0)
  })
  afterEach(() => {
    restoreResizeObserver()
    restoreLayout()
    measuredRowHeights = []
  })

  it('holds the pin, the mount and the reserved total at every frame of the growth', () => {
    setMeasuredTail(0)
    const { container, rerender } = render(streamingList(0))
    paint(container)

    expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
    expect(windowState(container).totalSize).toBe(BASE_TOTAL_PX + tailHeightAt(0))

    const frames: { step: number; tail: number; total: number; distance: number }[] = []
    for (let step = 1; step <= GROWTH_STEPS; step += 1) {
      setMeasuredTail(step)
      rerender(streamingList(step))
      paint(container)

      const { totalSize, indexes } = windowState(container)
      const distance = distanceFromBottom(container)
      frames.push({ step, tail: tailHeightAt(step), total: totalSize, distance })

      // Pinned: the reader is still looking at the bottom of the row.
      expect(distance).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
      // Mounted: never swapped for reserved space while it is the live row.
      expect(indexes).toContain(TAIL_INDEX)
      expect(screen.getByText(/streamed line 0/)).toBeInTheDocument()
      // Tracking: the reservation follows the measurement, not the estimate.
      expect(totalSize).toBe(BASE_TOTAL_PX + tailHeightAt(step))
      // Still a window, not the whole transcript remounted by the growth.
      expect(indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    }

    expect(frames).toHaveLength(GROWTH_STEPS)
    expect(frames.at(-1)?.tail).toBeGreaterThan(VIEWPORT_PX * 10)
    expect(Math.max(...frames.map((frame) => frame.distance))).toBeLessThanOrEqual(
      NATIVE_CHAT_BOTTOM_THRESHOLD_PX
    )
  })

  it('leaves a reader who scrolled up where they were, however far the row grows', () => {
    setMeasuredTail(4)
    const { container, rerender } = render(streamingList(4))
    paint(container)

    const readingAt = 2000
    scrollTranscript(container, readingAt)
    paint(container)
    expect(distanceFromBottom(container)).toBeGreaterThan(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()

    for (let step = 5; step <= GROWTH_STEPS; step += 1) {
      setMeasuredTail(step)
      rerender(streamingList(step))
      paint(container)

      const { totalSize, indexes } = windowState(container)
      // Not yanked: the offset the reader chose is the offset they still have.
      expect(scrollRoot(container).scrollTop).toBe(readingAt)
      // The row is off screen but still measured, which is what keeps the
      // reserved total — and so the scrollbar — honest while it grows.
      expect(indexes).toContain(TAIL_INDEX)
      expect(totalSize).toBe(BASE_TOTAL_PX + tailHeightAt(step))
    }

    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
  })
})
