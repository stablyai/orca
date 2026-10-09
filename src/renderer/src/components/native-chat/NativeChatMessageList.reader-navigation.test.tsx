// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import {
  BELOW_TRANSCRIPT_PX,
  deliverResizes,
  layout,
  list,
  marker,
  ROW_PX,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver,
  TRANSCRIPT_LENGTH
} from './native-chat-windowing-test-harness'

// Pacing is not this test's subject.
vi.mock('./use-native-chat-paced-text', async (importOriginal) =>
  (await import('./native-chat-unpaced-text-fixture')).unpacedTextModule(importOriginal)
)

afterEach(cleanup)

function scrollRoot(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  return scroller
}

const paintedScrollTops = new WeakMap<HTMLElement, number>()

/** Deliver resize and scroll events to a fixed point, as a painted frame would. */
function paint(container: HTMLElement): void {
  const scroller = scrollRoot(container)
  // Commit-time writes also dispatch their browser scroll event before the next paint.
  let lastScrollTop = paintedScrollTops.get(scroller) ?? 0
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false
    act(() => {
      changed = deliverResizes()
      vi.advanceTimersByTime(16)
    })
    if (scroller.scrollTop !== lastScrollTop) {
      lastScrollTop = scroller.scrollTop
      fireEvent.scroll(scroller)
      changed = true
    }
    if (!changed && pass >= 2) {
      paintedScrollTops.set(scroller, lastScrollTop)
      return
    }
  }
  throw new Error('the transcript never settled: resize and scroll kept moving it')
}

function distanceFromBottom(container: HTMLElement): number {
  const scroller = scrollRoot(container)
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
}

const transcript = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => marker(index))

function userMessage(index: number, text: string): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

function toolMessage(index: number): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'assistant',
    blocks: [
      { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
      { type: 'tool-result', output: '/repo' }
    ],
    timestamp: index + 1,
    source: 'transcript'
  }
}

function liveList(messages: NativeChatMessage[]): React.JSX.Element {
  return <NativeChatMessageList session={session(messages)} isWorking expandSignal={false} />
}

/** The last `count` closed tool runs, with the row each sits in. */
function closedRuns(count: number): { toggle: HTMLElement; rowIndex: number }[] {
  return screen
    .getAllByRole('button', { expanded: false })
    .slice(-count)
    .map((toggle) => {
      const row = toggle.closest<HTMLElement>('[data-index]')
      if (!row) {
        throw new Error('the tool run has no mounted row')
      }
      return { toggle, rowIndex: Number(row.dataset.index) }
    })
}

/** Click a run's toggle and let its row re-measure, as a painted frame would. */
function toggleRun(container: HTMLElement, toggle: HTMLElement, openRows: readonly number[]): void {
  fireEvent.click(toggle)
  const heights = Array.from({ length: Math.max(-1, ...openRows) + 1 }, () => ROW_PX)
  for (const rowIndex of openRows) {
    heights[rowIndex] = ROW_PX * 6
  }
  layout.measuredRowHeights = heights
  paint(container)
}

function offersJumpToLatest(): boolean {
  return screen.queryByRole('button', { name: 'Jump to latest' }) !== null
}

describe('reader navigation', () => {
  let restore: (() => void)[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    restore = [stubLayout({ scrollGeometry: true, offsetChain: true }), stubResizeObserver()]
    layout.belowTranscriptPx = BELOW_TRANSCRIPT_PX
    layout.aboveTranscriptPx = 0
  })
  afterEach(() => {
    for (const undo of restore.toReversed()) {
      undo()
    }
    layout.measuredRowHeights = []
    vi.useRealTimers()
  })

  it('brings a reader who scrolled up to what they just sent, and follows its reply', () => {
    const handle = createRef<NativeChatMessageListHandle>()
    const view = (messages: NativeChatMessage[], isWorking: boolean) => (
      <NativeChatMessageList
        ref={handle}
        session={session(messages)}
        isWorking={isWorking}
        expandSignal={false}
      />
    )
    const { container, rerender } = render(view(transcript, false))
    paint(container)
    scrollTranscript(container, 1000)
    paint(container)
    // Anti-vacuous: the reader is parked well above the end.
    expect(distanceFromBottom(container)).toBeGreaterThan(1000)

    act(() => handle.current?.revealLatest())
    const sent = [...transcript, userMessage(TRANSCRIPT_LENGTH, 'follow-up question')]
    rerender(view(sent, true))
    paint(container)
    rerender(view([...sent, marker(TRANSCRIPT_LENGTH + 1)], true))
    paint(container)

    expect(distanceFromBottom(container)).toBe(0)
    expect(screen.getByText('follow-up question')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('stops following when the reader pages up from the focused transcript', () => {
    const { container, rerender } = render(liveList(transcript))
    paint(container)
    const scroller = scrollRoot(container)
    scroller.focus()
    fireEvent.keyDown(scroller, { key: 'PageUp' })
    // The browser pages the focused scroller; the key is all that says a reader moved it.
    scroller.scrollTop -= scroller.clientHeight
    fireEvent.scroll(scroller)
    const pagedTo = scroller.scrollTop
    rerender(liveList([...transcript, marker(TRANSCRIPT_LENGTH)]))
    paint(container)

    expect(scroller.scrollTop).toBe(pagedTo)
    expect(offersJumpToLatest()).toBe(true)
  })

  it('leaves a reader who scrolled up in place when a message arrives from another device', () => {
    const { container, rerender } = render(liveList(transcript))
    paint(container)
    scrollTranscript(container, 1000)
    paint(container)
    const readingAt = scrollRoot(container).scrollTop

    const delivered = [...transcript, userMessage(TRANSCRIPT_LENGTH, 'sent from the phone')]
    rerender(liveList(delivered))
    paint(container)
    rerender(liveList([...delivered, marker(TRANSCRIPT_LENGTH + 1)]))
    paint(container)

    expect(scrollRoot(container).scrollTop).toBe(readingAt)
    expect(offersJumpToLatest()).toBe(true)
  })

  it('keeps following when the reader opens a tool run at the live end', () => {
    const toolIndex = TRANSCRIPT_LENGTH
    const withTool = [...transcript, toolMessage(toolIndex)]
    const { container, rerender } = render(liveList(withTool))
    paint(container)
    // Anti-vacuous: following the end, so the run sits at the bottom of the view.
    expect(distanceFromBottom(container)).toBe(0)
    const scrollTopBeforeOpen = scrollRoot(container).scrollTop

    const [run] = closedRuns(1)
    toggleRun(container, run.toggle, [run.rowIndex])
    expect(run.toggle).toHaveAttribute('aria-expanded', 'true')
    rerender(liveList([...withTool, marker(toolIndex + 1), marker(toolIndex + 2)]))
    paint(container)

    // The opened output and the streamed rows both pushed the end down, and the view went with it.
    expect(scrollRoot(container).scrollTop).toBeGreaterThan(scrollTopBeforeOpen)
    expect(distanceFromBottom(container)).toBe(0)
    expect(offersJumpToLatest()).toBe(false)
  })

  describe('closing what the reader opened', () => {
    const toolIndex = TRANSCRIPT_LENGTH
    const withTool = [...transcript, toolMessage(toolIndex)]
    const streamedOn = [...withTool, marker(toolIndex + 1), marker(toolIndex + 2)]

    it('stays where the reader scrolled to while it was open', () => {
      const { container, rerender } = render(liveList(withTool))
      paint(container)
      const [run] = closedRuns(1)
      toggleRun(container, run.toggle, [run.rowIndex])
      const scrolledTo = scrollRoot(container).scrollTop - 100
      scrollTranscript(container, scrolledTo)
      paint(container)

      toggleRun(container, run.toggle, [])
      rerender(liveList(streamedOn))
      paint(container)

      expect(scrollRoot(container).scrollTop).toBe(scrolledTo)
      expect(offersJumpToLatest()).toBe(true)
    })

    it('leaves a reader who had already scrolled away where they are', () => {
      const { container, rerender } = render(liveList(withTool))
      paint(container)
      const scrolledTo = scrollRoot(container).scrollTop - 100
      scrollTranscript(container, scrolledTo)
      paint(container)
      const [run] = closedRuns(1)

      toggleRun(container, run.toggle, [run.rowIndex])
      toggleRun(container, run.toggle, [])
      rerender(liveList(streamedOn))
      paint(container)

      expect(scrollRoot(container).scrollTop).toBe(scrolledTo)
      expect(offersJumpToLatest()).toBe(true)
    })
  })

  it('keeps following when an earlier turn expands under a pending tail pin', () => {
    const messages = [
      userMessage(0, 'Earlier turn'),
      ...Array.from({ length: 8 }, (_, i) => toolMessage(i + 1)),
      marker(9),
      userMessage(10, 'Current turn'),
      marker(11)
    ]
    const { container } = render(
      <NativeChatMessageList
        session={session(messages)}
        isWorking
        expandSignal={false}
        settledTurns={new Map([['message-0', { startedAt: 1, workedSeconds: 1 }]])}
      />
    )
    const lastRow = screen.getByText('marker-11').closest<HTMLElement>('[data-index]')
    if (!lastRow) {
      throw new Error('The current answer is not mounted')
    }
    layout.measuredRowHeights = Array.from(
      { length: Number(lastRow.dataset.index) + 1 },
      (_, index) => (index === Number(lastRow.dataset.index) ? ROW_PX * 20 : ROW_PX)
    )
    paint(container)
    const scroller = scrollRoot(container)
    const window = container.querySelector<HTMLElement>('[data-native-chat-window]')
    const beforeSlots = window?.querySelectorAll('[data-index]').length ?? 0
    // A pin created outside the painted frames is still waiting to reconcile by numeric index.
    layout.belowTranscriptPx += 20
    deliverResizes()
    expect(scroller.scrollTop).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle turn details' }))
    // Anti-vacuous: the expansion inserted rows before the tail the pin named.
    expect(window?.querySelectorAll('[data-index]').length ?? 0).toBeGreaterThan(beforeSlots)
    paint(container)
    act(() => vi.advanceTimersByTime(160))
    paint(container)

    expect(distanceFromBottom(container)).toBe(0)
    expect(screen.getByText('marker-11')).toBeInTheDocument()
  })

  it.each([false, true])(
    'keeps Space scrolling in the focused transcript (shift=%s)',
    (shiftKey) => {
      const insertTypedText = vi.fn(() => true)
      const focus = vi.fn(() => true)
      const composer = {
        focus,
        insertTypedText,
        acceptsText: () => true,
        appendText: vi.fn(),
        handlePasteEvent: vi.fn(),
        pasteFromClipboard: vi.fn(),
        contains: () => false
      }
      const { container } = render(
        <div onKeyDownCapture={(event) => routeNativeChatRootKeyToInput(event, composer, null)}>
          {list(transcript)}
        </div>
      )
      const root = scrollRoot(container)
      root.focus()
      fireEvent.keyDown(root, { key: ' ', shiftKey })
      expect(document.activeElement).toBe(root)
      expect(insertTypedText).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
      fireEvent.keyDown(root, { key: 'a' })
      expect(insertTypedText).toHaveBeenCalledWith('a')
    }
  )

  it('makes the transcript a keyboard stop, so the scroll keys can reach it', () => {
    const { container } = render(list(transcript))

    expect(scrollRoot(container)).toHaveAttribute('tabindex', '0')
  })

  it('names the transcript as a region, so a focused scroll stop is announced', () => {
    const { container } = render(list(transcript))

    expect(screen.getByRole('region', { name: 'Conversation' })).toBe(scrollRoot(container))
  })
})

describe('disclosure following across retained pane visibility', () => {
  let visible = true
  let restore: (() => void)[] = []
  beforeEach(() => {
    visible = true
    vi.useFakeTimers()
    layout.belowTranscriptPx = BELOW_TRANSCRIPT_PX
    layout.aboveTranscriptPx = 0
    layout.measuredRowHeights = []
    restore = [
      stubLayout({ scrollGeometry: true, offsetChain: true, isVisible: () => visible }),
      stubResizeObserver()
    ]
  })
  afterEach(() => {
    for (const undo of restore.toReversed()) {
      undo()
    }
    layout.measuredRowHeights = []
    vi.useRealTimers()
  })

  function view(messages: NativeChatMessage[]): React.JSX.Element {
    return (
      <NativeChatMessageList
        session={session(messages)}
        isVisible={visible}
        isWorking
        expandSignal={false}
      />
    )
  }

  it.each([false, true])(
    'follows passive growth after underflow disclosure (hide before settlement=%s)',
    (hideBeforeSettlement) => {
      const initial = [marker(0), toolMessage(1)]
      const rendered = render(view(initial))
      paint(rendered.container)
      const scroller = scrollRoot(rendered.container)
      expect(scroller.scrollHeight).toBeLessThan(scroller.clientHeight)
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      if (hideBeforeSettlement) {
        visible = false
        rendered.rerender(view(initial))
        act(() => vi.advanceTimersByTime(300))
        visible = true
        rendered.rerender(view(initial))
      }
      paint(rendered.container)
      expect(scroller.scrollHeight).toBeLessThan(scroller.clientHeight)
      expect(scroller.scrollTop).toBe(0)
      const grown = [...initial, ...Array.from({ length: 200 }, (_, i) => marker(i + 10))]
      rendered.rerender(view(grown))
      paint(rendered.container)
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight + 1000)
      expect(distanceFromBottom(rendered.container)).toBe(0)
      expect(screen.getByText('marker-209')).toBeInTheDocument()
    }
  )

  it.each([false, true])(
    'restores distant history after interrupted disclosure (growth while hidden=%s)',
    (growWhileHidden) => {
      const initial = transcript.with(20, toolMessage(20))
      const grown = [...initial, ...Array.from({ length: 200 }, (_, i) => marker(i + 1000))]
      const rendered = render(view(initial))
      paint(rendered.container)
      scrollTranscript(rendered.container, 900)
      paint(rendered.container)
      const scroller = scrollRoot(rendered.container)
      expect(distanceFromBottom(rendered.container)).toBeGreaterThan(1000)
      const readingAt = scroller.scrollTop
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      visible = false
      rendered.rerender(view(growWhileHidden ? grown : initial))
      paint(rendered.container)
      act(() => vi.advanceTimersByTime(300))
      visible = true
      rendered.rerender(view(growWhileHidden ? grown : initial))
      paint(rendered.container)
      expect(scroller.scrollTop).toBe(readingAt)
      expect(distanceFromBottom(rendered.container)).toBeGreaterThan(1000)
      expect(offersJumpToLatest()).toBe(true)
      rendered.rerender(view([...grown, marker(1200)]))
      paint(rendered.container)
      expect(scroller.scrollTop).toBe(readingAt)
      expect(distanceFromBottom(rendered.container)).toBeGreaterThan(1000)
    }
  )
})
