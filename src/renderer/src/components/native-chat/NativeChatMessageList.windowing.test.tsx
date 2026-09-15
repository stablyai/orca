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
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
  NATIVE_CHAT_FOLLOW_REARM_PX
} from './native-chat-autoscroll'
import { NATIVE_CHAT_ROW_GAP_PX } from './native-chat-row-height-estimate'
import {
  BELOW_TRANSCRIPT_PX,
  deliverResizes,
  layout,
  list,
  marker,
  ROW_PITCH_PX,
  ROW_PX,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver,
  TRANSCRIPT_LENGTH,
  VIEWPORT_PX,
  windowState
} from './native-chat-windowing-test-harness'

afterEach(cleanup)

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

  it('lets a rail jump supersede a previously revealed diff', () => {
    const withPrompts = [
      ...items.slice(0, 2),
      journalItem(
        'user-2',
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Second prompt' }] },
        3
      ),
      journalItem(
        'user-3',
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Third prompt' }] },
        4
      ),
      ...items.slice(2)
    ].map((item, index) => ({ ...item, sequence: index + 1 }))
    const scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    const { container } = render(
      <NativeChatMessageList
        session={session(projectStructuredItemsToNativeChat(withPrompts))}
        journalItems={withPrompts}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
    scrollTranscript(container, 6000)
    expect(screen.getByText('Edited file')).toBeInTheDocument()
    scrollTo.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    fireEvent.click(screen.getByRole('button', { name: 'Second prompt' }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Edited file')).toBeNull()

    scrollTranscript(container, 0)
    scrollTo.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })
})

// The rail borrows the reveal's pin to reach a row the window has left behind.
// Borrowing the pin means it also has to give it back: the request is what
// outranks a later reveal, and `slots` is rebuilt every render, so an effect that
// merely watched it would re-scroll forever.
describe('jumping to a message from the rail', () => {
  let restoreLayout = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    restoreLayout()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function userMarker(index: number): NativeChatMessage {
    return {
      id: `message-${index}`,
      role: 'user',
      blocks: [{ type: 'text', text: `prompt-${index}` }],
      timestamp: index + 1,
      source: 'transcript'
    }
  }

  const conversation = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
    index % 10 === 0 ? userMarker(index) : marker(index)
  )

  /** Open the hover panel through the trigger and click the first prompt. */
  function jumpToFirstPrompt(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    fireEvent.click(screen.getByRole('button', { name: 'prompt-0' }))
    act(() => {
      vi.advanceTimersByTime(300)
    })
  }

  it('scrolls once for a selection, not again on every later render', () => {
    vi.useFakeTimers()
    const scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    const { container, rerender } = render(list(conversation))
    scrollTranscript(container, 6000)

    jumpToFirstPrompt()
    expect(scrollTo).toHaveBeenCalled()

    // A streaming turn re-renders constantly with the same messages. The jump is
    // spent; nothing here may drag the reader back to the row they left.
    scrollTo.mockClear()
    rerender(list(conversation))
    rerender(list(conversation))
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('releases the pin once the jump is spent', () => {
    vi.useFakeTimers()
    const scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    const { container } = render(list(conversation))
    scrollTranscript(container, 6000)

    jumpToFirstPrompt()
    expect(scrollTo).toHaveBeenCalled()

    // The request is spent as soon as the scroll is issued, so the row it pinned
    // is not held in the window afterwards. A pin still standing here would also
    // still outrank a diff reveal, which shares the same slot.
    expect(windowState(container).indexes).not.toContain(0)
  })
})

describe('transcript with a hidden scroll root', () => {
  const transcript = Array.from({ length: 40 }, (_, index) => marker(index))

  it('keeps the transcript bounded and rehydrates when the viewport becomes measurable', () => {
    let viewportHeight = 0
    const restoreLayout = stubLayout({ viewportHeight: () => viewportHeight })
    const restoreResizeObserver = stubResizeObserver()
    try {
      const { container } = render(list(transcript))

      expect(container.querySelector('[data-native-chat-window]')).toBeInTheDocument()
      expect(container.querySelectorAll('[data-index]')).toHaveLength(0)
      expect(screen.queryByText(/^marker-/)).toBeNull()
      const column = container.querySelector('.max-w-4xl')
      expect(column?.children).toHaveLength(1)

      viewportHeight = VIEWPORT_PX
      act(() => {
        deliverResizes()
      })
      const { indexes } = windowState(container)
      expect(indexes.length).toBeGreaterThan(0)
      expect(indexes.length).toBeLessThan(transcript.length)
    } finally {
      restoreResizeObserver()
      restoreLayout()
    }
  })
})

// A row that grows in place: the same message id, more content, a taller measured
// box — what a streaming reply looks like to the window. Whole-message appends
// arrive at their final height and are a different case; this is the one where
// the row the reader is looking at keeps changing size underneath them.
//
// Exercise the real virtualizer together with the transcript's follow owner.
describe('transcript follow ownership across growth and appends', () => {
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

  function appendedTranscript(count: number): NativeChatMessage[] {
    return [
      ...transcript,
      ...Array.from({ length: count }, (_, index) => marker(TRANSCRIPT_LENGTH + index))
    ]
  }

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
    layout.measuredRowHeights = heights
  }

  let restoreLayout = (): void => {}
  let restoreResizeObserver = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
    restoreResizeObserver = stubResizeObserver()
    layout.belowTranscriptPx = BELOW_TRANSCRIPT_PX
    layout.aboveTranscriptPx = 0
    setMeasuredTail(0)
  })
  afterEach(() => {
    restoreResizeObserver()
    restoreLayout()
    layout.measuredRowHeights = []
    layout.belowTranscriptPx = BELOW_TRANSCRIPT_PX
    layout.aboveTranscriptPx = 0
    vi.restoreAllMocks()
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

  it.each([0, 100])(
    'keeps a reader parked above a growing row with a %i px initial measurement delta',
    (measurementDelta) => {
      setMeasuredTail(4)
      layout.measuredRowHeights = layout.measuredRowHeights.map((height, index) =>
        index === TAIL_INDEX ? height + measurementDelta : height
      )
      const { container, rerender } = render(streamingList(4))
      paint(container)
      const scroller = scrollRoot(container)

      const parkGapPx = NATIVE_CHAT_BOTTOM_THRESHOLD_PX - 8
      const parkedAt = scroller.scrollHeight - scroller.clientHeight - parkGapPx
      scrollTranscript(container, parkedAt)
      expect(distanceFromBottom(container)).toBe(parkGapPx)
      // Not the "scrolled far away" case above: the latest message is still on
      // screen, so there is nothing to offer a way back to yet.
      expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()

      setMeasuredTail(5)
      rerender(streamingList(5))
      paint(container)
      expect(scroller.scrollTop).toBe(parkedAt)

      let previousDistance = distanceFromBottom(container)
      for (let step = 6; step <= GROWTH_STEPS; step += 1) {
        setMeasuredTail(step)
        rerender(streamingList(step))
        paint(container)

        // The offset stops moving at all...
        expect(scroller.scrollTop).toBe(parkedAt)
        // ...so the end runs away from the reader instead of carrying them along.
        const distance = distanceFromBottom(container)
        expect(distance).toBeGreaterThan(previousDistance)
        previousDistance = distance
      }

      expect(previousDistance).toBeGreaterThan(VIEWPORT_PX)
      expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
    }
  )

  it('leaves a parked reader in place through repeated appends', () => {
    const { container, rerender } = render(list(transcript))
    paint(container)
    const scroller = scrollRoot(container)
    const parkedAt = scroller.scrollHeight - scroller.clientHeight - 40
    scrollTranscript(container, parkedAt)

    for (let count = 1; count <= 8; count += 1) {
      rerender(list(appendedTranscript(count)))
      paint(container)
      expect(scroller.scrollTop).toBe(parkedAt)
      expect(windowState(container).indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    }
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
  })

  it('follows repeated appends until the reader detaches', () => {
    const { container, rerender } = render(list(transcript))
    paint(container)
    const scroller = scrollRoot(container)
    for (let count = 1; count <= 8; count += 1) {
      rerender(list(appendedTranscript(count)))
      paint(container)
      expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
      fireEvent.scroll(scroller)
    }

    const parkedAt = scroller.scrollTop - 22
    scrollTranscript(container, parkedAt)
    rerender(list(appendedTranscript(9)))
    paint(container)
    expect(scroller.scrollTop).toBe(parkedAt)
  })

  it('follows an empty transcript through underflow into scrollable output', () => {
    const { container, rerender } = render(list([]))
    paint(container)
    expect(scrollRoot(container).scrollTop).toBe(0)
    rerender(list(transcript.slice(0, 1)))
    paint(container)
    expect(scrollRoot(container).scrollTop).toBe(0)
    fireEvent.scroll(scrollRoot(container))
    rerender(list(transcript))
    paint(container)
    expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
    expect(windowState(container).indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
  })

  it.each(['reader', 'jump'] as const)('rearms growth and append following via %s', (rearm) => {
    setMeasuredTail(4)
    const { container, rerender } = render(streamingList(4))
    paint(container)
    const scroller = scrollRoot(container)
    fireEvent.scroll(scroller)
    const parkedAt = scroller.scrollTop - 22
    scrollTranscript(container, parkedAt)
    setMeasuredTail(5)
    rerender(streamingList(5))
    paint(container)
    expect(scroller.scrollTop).toBe(parkedAt)

    if (rearm === 'reader') {
      scrollTranscript(
        container,
        scroller.scrollHeight - scroller.clientHeight - NATIVE_CHAT_FOLLOW_REARM_PX
      )
    } else {
      fireEvent.click(screen.getByRole('button', { name: /jump to latest/i }))
    }
    paint(container)
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
    for (let step = 6; step <= 8; step += 1) {
      setMeasuredTail(step)
      rerender(streamingList(step))
      paint(container)
      expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
      expect(windowState(container).indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    }
    rerender(list([...transcriptAt(8), marker(TRANSCRIPT_LENGTH)]))
    paint(container)
    expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
  })

  it('preserves the visible row anchor across prepends while detached', () => {
    const { container, rerender } = render(list(transcript))
    paint(container)
    const readingAt = 2000
    scrollTranscript(container, readingAt)
    paint(container)

    const earlier = Array.from({ length: 10 }, (_, index) => marker(index - 10))
    rerender(list([...earlier, ...transcript]))
    paint(container)
    expect(scrollRoot(container).scrollTop).toBe(readingAt + earlier.length * ROW_PITCH_PX)
    expect(windowState(container).indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
  })

  it('compensates a measurement entirely above the viewport without reattaching', () => {
    const { container, rerender } = render(list(transcript))
    paint(container)
    const scroller = scrollRoot(container)
    // Establish a forward scroll direction before reading at this offset. The
    // backward-scroll suppression below covers the separate case where a reader
    // is still moving upward while overscan rows settle.
    scrollTranscript(container, 0)
    paint(container)
    const readingAt = 2000
    scrollTranscript(container, readingAt)
    paint(container)
    const aboveIndex = windowState(container).indexes[0]!
    expect((aboveIndex + 1) * ROW_PITCH_PX).toBeLessThan(readingAt)
    for (const growth of [100, 200]) {
      layout.measuredRowHeights = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
        index === aboveIndex ? ROW_PX + growth : ROW_PX
      )
      paint(container)
      expect(scroller.scrollTop).toBe(readingAt + growth)
    }
    rerender(list(appendedTranscript(1)))
    paint(container)
    expect(scroller.scrollTop).toBe(readingAt + 200)
    expect(windowState(container).indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
  })

  it('keeps following when a pin echo arrives after the document grows', () => {
    setMeasuredTail(0)
    const { container } = render(streamingList(0))
    paint(container)
    const scroller = scrollRoot(container)

    setMeasuredTail(1)
    expect(deliverResizes()).toBe(true)
    const pinnedAt = scroller.scrollTop
    layout.belowTranscriptPx += 2_000

    fireEvent.scroll(scroller)

    expect(scroller.scrollTop).toBe(pinnedAt)
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
    paint(container)
    expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_FOLLOW_REARM_PX)
  })

  it('does not counter upward scrolling when measured overscan rows settle', () => {
    const readingAt = 2000
    const aboveIndex = Math.floor(readingAt / ROW_PITCH_PX) - 1
    const { container } = render(list(transcript))
    paint(container)
    scrollTranscript(container, readingAt + 100)
    paint(container)
    layout.measuredRowHeights = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      index === aboveIndex ? ROW_PX + 10 : ROW_PX
    )
    paint(container)
    scrollTranscript(container, readingAt)
    paint(container)
    const scroller = scrollRoot(container)
    const scrollTo = vi.spyOn(scroller, 'scrollTo')

    layout.measuredRowHeights = layout.measuredRowHeights.map((height, index) =>
      index === aboveIndex ? height + 20 : height
    )
    paint(container)

    expect(scroller.scrollTop).toBe(readingAt)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('keeps the offset when a visible row shrinks past the viewport top', () => {
    const focusedIndex = 45
    const { container } = render(list(transcript))
    paint(container)
    scrollTranscript(container, focusedIndex * ROW_PITCH_PX)
    paint(container)
    layout.measuredRowHeights = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      index === focusedIndex ? 100 : ROW_PX
    )
    paint(container)
    const readingAt = focusedIndex * ROW_PITCH_PX + 60
    scrollTranscript(container, readingAt)
    paint(container)
    const scroller = scrollRoot(container)
    const scrollTo = vi.spyOn(scroller, 'scrollTo')

    layout.measuredRowHeights = layout.measuredRowHeights.map((height, index) =>
      index === focusedIndex ? 30 : height
    )
    paint(container)

    expect(scroller.scrollTop).toBe(readingAt)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('settles a pending end reconcile after the reader keeps scrolling away', async () => {
    setMeasuredTail(0)
    const { container } = render(streamingList(0))
    const scroller = scrollRoot(container)
    // Trigger a pin outside React's act wrapper so its TanStack rAF reconcile is
    // still pending when the reader moves away.
    setMeasuredTail(1)
    expect(deliverResizes()).toBe(true)
    const scheduleSpy = vi.spyOn(window, 'requestAnimationFrame')
    const scrollToSpy = vi.spyOn(scroller, 'scrollTo')
    const readingAt = 2000
    scroller.scrollTop = readingAt
    fireEvent.scroll(scroller)
    expect(scrollToSpy).toHaveBeenLastCalledWith({ behavior: 'auto', top: readingAt })
    scroller.scrollTop = 1800
    fireEvent.scroll(scroller)
    expect(scrollToSpy).toHaveBeenLastCalledWith({ behavior: 'auto', top: 1800 })

    await act(async () => {
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
    })

    const scheduledFrames = scheduleSpy.mock.calls.length
    scheduleSpy.mockRestore()
    scrollToSpy.mockRestore()
    expect(scheduledFrames).toBeLessThanOrEqual(8)
    expect(scroller.scrollTop).toBe(1800)
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
  })

  // With something above the spacer, the two parties stop agreeing on where the
  // end is: the transcript measures it from the document, the virtualizer from
  // the spacer's own height against a container-absolute offset. The second is
  // short by everything outside the spacer, so it reads a reader who is clearly
  // above the end as sitting on it.
  describe('with a gutter above the transcript', () => {
    /** `pt-10` plus the "Load earlier" block and its gap — what sits above the
     *  spacer once a resumed session still has older history to page in. */
    const GUTTER_PX = 92
    /** Far enough up that the transcript itself calls the reader detached, and
     *  still inside the band the virtualizer computes (48 + 92 + 24). */
    const READING_ABOVE_END_PX = 96
    // A nonzero delta seeds the size cache; zero exercises first-measure growth.
    const MEASURE_SKEW_PX = 7

    function setSkewedTail(step: number, skew = MEASURE_SKEW_PX): void {
      const heights = Array.from({ length: TRANSCRIPT_LENGTH }, () => ROW_PX)
      heights[TAIL_INDEX] = tailHeightAt(step) + skew
      layout.measuredRowHeights = heights
    }

    beforeEach(() => {
      layout.aboveTranscriptPx = GUTTER_PX
    })

    it.each([0, MEASURE_SKEW_PX])(
      'leaves a reader just above the end while the row grows (skew %i)',
      (skew) => {
        setSkewedTail(4, skew)
        const { container, rerender } = render(streamingList(4))
        paint(container)
        const scroller = scrollRoot(container)

        const readingAt = scroller.scrollHeight - scroller.clientHeight - READING_ABOVE_END_PX
        scrollTranscript(container, readingAt)
        paint(container)
        expect(distanceFromBottom(container)).toBe(READING_ABOVE_END_PX)

        for (let step = 5; step <= 10; step += 1) {
          setSkewedTail(step, skew)
          rerender(streamingList(step))
          paint(container)

          // Not dragged along: the offset the reader chose is the offset they keep,
          // however much the row below them grows.
          expect(scroller.scrollTop).toBe(readingAt)
        }
      }
    )

    it('still pins a reader who is at the end, with the gutter in the document', () => {
      setSkewedTail(4)
      const { container, rerender } = render(streamingList(4))
      paint(container)
      expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)

      for (let step = 5; step <= 10; step += 1) {
        setSkewedTail(step)
        rerender(streamingList(step))
        paint(container)

        expect(distanceFromBottom(container)).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
      }
    })
  })
})
