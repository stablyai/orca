// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import type { NativeChatRailOutlineEntry } from './native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import {
  deliverResizes,
  layout,
  marker,
  overrideLayoutProperty,
  ROW_PITCH_PX,
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

function chat(
  length: number,
  isVisible: boolean,
  {
    ref,
    readCurrent = true,
    railOutline,
    loadEarlier
  }: {
    ref?: React.Ref<NativeChatMessageListHandle>
    readCurrent?: boolean
    railOutline?: readonly NativeChatRailOutlineEntry[]
    loadEarlier?: () => Promise<NativeChatOlderPageResult>
  } = {}
): React.JSX.Element {
  const messages: NativeChatMessage[] = Array.from({ length }, (_, index) => ({
    ...marker(index),
    journalPosition: { sequence: index + 1, index: 0 }
  }))
  return (
    <NativeChatMessageList
      ref={ref}
      session={{ ...session(messages), readCurrent, ...(loadEarlier ? { loadEarlier } : {}) }}
      railOutline={railOutline}
      isVisible={isVisible}
      isWorking={false}
      expandSignal={false}
    />
  )
}

describe('the "New" marker in the transcript', () => {
  let paneShown = true
  let restore: (() => void)[] = []
  beforeEach(() => {
    paneShown = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    restore = [
      stubLayout({ scrollGeometry: true, offsetChain: true, isVisible: () => paneShown }),
      stubResizeObserver()
    ]
  })
  afterEach(() => {
    for (const undo of restore.toReversed()) {
      undo()
    }
    layout.measuredRowHeights = []
    vi.restoreAllMocks()
  })

  // The window mounts only rows near the view; the marker's row is far from the end it opens at.
  it('is drawn above the first row that came while the chat was hidden, however far back', () => {
    const { rerender } = render(chat(TRANSCRIPT_LENGTH, true))
    rerender(chat(TRANSCRIPT_LENGTH, false))
    rerender(chat(TRANSCRIPT_LENGTH + 60, true))

    const row = screen.getByRole('separator', { name: 'New' }).closest<HTMLElement>('[data-index]')
    expect(row?.dataset.index).toBe(String(TRANSCRIPT_LENGTH))
  })

  it('tells a screen reader that new messages came, in a region that was already there', () => {
    const { container, rerender } = render(chat(TRANSCRIPT_LENGTH, true))
    const region = container.querySelector('[data-native-chat-scroll] ~ [aria-live="polite"]')
    expect(region).toBeEmptyDOMElement()

    rerender(chat(TRANSCRIPT_LENGTH, false))
    rerender(chat(TRANSCRIPT_LENGTH + 60, true))
    expect(region).toHaveTextContent('New messages arrived while you were away')
  })

  it('goes once the reader sends something', () => {
    const ref = createRef<NativeChatMessageListHandle>()
    const { rerender } = render(chat(TRANSCRIPT_LENGTH, true, { ref }))
    rerender(chat(TRANSCRIPT_LENGTH, false, { ref }))
    rerender(chat(TRANSCRIPT_LENGTH + 60, true, { ref }))
    expect(screen.getByRole('separator', { name: 'New' })).toBeInTheDocument()

    act(() => ref.current?.revealLatest())

    expect(screen.queryByRole('separator', { name: 'New' })).toBeNull()
  })

  describe('when the reader comes back to new rows', () => {
    /** Catch up after restoring the hidden pane’s scroll position. */
    function returnToNewRows(rerender: (ui: React.JSX.Element) => void, count = 60): void {
      paneShown = false
      rerender(chat(TRANSCRIPT_LENGTH, false, { readCurrent: false }))
      paneShown = true
      rerender(chat(TRANSCRIPT_LENGTH, true, { readCurrent: false }))
      rerender(chat(TRANSCRIPT_LENGTH + count, true))
    }
    const scrollTop = (container: HTMLElement): number | undefined =>
      container.querySelector('[data-native-chat-scroll]')?.scrollTop

    it('brings a reader who was at the end to where the new rows begin', () => {
      const { container, rerender } = render(chat(TRANSCRIPT_LENGTH, true))
      returnToNewRows(rerender)

      expect(scrollTop(container)).toBe(TRANSCRIPT_LENGTH * ROW_PITCH_PX)
    })

    it('keeps the reader where the new rows begin while a reply is still being drawn', async () => {
      const { container, rerender } = render(chat(TRANSCRIPT_LENGTH, true))
      returnToNewRows(rerender, 1)

      const drawn: number[] = []
      drawn[TRANSCRIPT_LENGTH] = 2_000
      layout.measuredRowHeights = drawn
      act(() => void deliverResizes())
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })

      expect(scrollTop(container)).toBe(TRANSCRIPT_LENGTH * ROW_PITCH_PX)
    })

    it('leaves a reader who was parked further up where they were', () => {
      const { container, rerender } = render(chat(TRANSCRIPT_LENGTH, true))
      const readingAt = 2_000
      scrollTranscript(container, readingAt)
      returnToNewRows(rerender)

      expect(screen.getByRole('separator', { name: 'New' })).toBeInTheDocument()
      expect(scrollTop(container)).toBe(readingAt)
    })

    it.each(['wheel', 'touch'] as const)(
      'keeps recent context when %s precedes foreground history catch-up',
      async (gesture) => {
        const { container, rerender } = render(chat(TRANSCRIPT_LENGTH, true))
        vi.mocked(document.hasFocus).mockReturnValue(false)
        fireEvent.blur(window)
        rerender(chat(TRANSCRIPT_LENGTH + 1000, true, { readCurrent: false }))
        vi.mocked(document.hasFocus).mockReturnValue(true)
        fireEvent.focus(window)
        const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')!
        if (gesture === 'wheel') {
          fireEvent.wheel(scroller, { deltaY: -100 })
        } else {
          fireEvent.touchMove(scroller)
        }
        scroller.scrollTop -= 100
        fireEvent.scroll(scroller)
        const readingAt = scroller.scrollTop
        expect(readingAt).toBeGreaterThan(TRANSCRIPT_LENGTH * ROW_PITCH_PX)
        rerender(chat(TRANSCRIPT_LENGTH + 1000, true))
        act(() => void deliverResizes())
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
        })

        expect(scrollTop(container)).toBe(readingAt)
        expect(screen.getByRole('separator', { name: 'New' })).toBeInTheDocument()
      }
    )

    it('keeps Jump to latest intent when foreground history catches up before a scroll event', async () => {
      const { container, rerender } = render(chat(TRANSCRIPT_LENGTH, true))
      scrollTranscript(container, 2_000)
      vi.mocked(document.hasFocus).mockReturnValue(false)
      fireEvent.blur(window)
      rerender(chat(TRANSCRIPT_LENGTH + 1000, true, { readCurrent: false }))
      vi.mocked(document.hasFocus).mockReturnValue(true)
      fireEvent.focus(window)

      fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
      const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')!
      const latest = scroller.scrollTop
      expect(latest).toBe(scroller.scrollHeight - scroller.clientHeight)
      rerender(chat(TRANSCRIPT_LENGTH + 1000, true))
      act(() => void deliverResizes())
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      })

      expect(scroller.scrollTop).toBe(latest)
      expect(screen.getByRole('separator', { name: 'New' })).toBeInTheDocument()
    })

    it('keeps an unloaded rail selection while foreground catch-up finishes before its page', async () => {
      restore.push(overrideLayoutProperty('clientWidth', { get: () => 800 }))
      let finishPage: ((result: NativeChatOlderPageResult) => void) | undefined
      const loadEarlier = vi.fn(
        () =>
          new Promise<NativeChatOlderPageResult>((resolve) => {
            finishPage = resolve
          })
      )
      const options = {
        railOutline: [{ id: 'older-prompt', text: 'Older prompt', hasImages: false }],
        loadEarlier
      }
      const { container, rerender } = render(chat(TRANSCRIPT_LENGTH, true, options))
      vi.mocked(document.hasFocus).mockReturnValue(false)
      fireEvent.blur(window)
      rerender(chat(TRANSCRIPT_LENGTH + 1000, true, { ...options, readCurrent: false }))
      vi.mocked(document.hasFocus).mockReturnValue(true)
      fireEvent.focus(window)
      fireEvent.click(screen.getByRole('button', { name: 'Older prompt' }))
      expect(loadEarlier).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Older prompt' })).toHaveAttribute(
        'aria-busy',
        'true'
      )
      const readingAt = scrollTop(container)
      expect(readingAt).toBeGreaterThan(TRANSCRIPT_LENGTH * ROW_PITCH_PX)

      rerender(chat(TRANSCRIPT_LENGTH + 1000, true, options))
      act(() => void deliverResizes())
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      })

      expect(scrollTop(container)).toBe(readingAt)
      expect(screen.getByRole('button', { name: 'Older prompt' })).toHaveAttribute(
        'aria-busy',
        'true'
      )
      expect(screen.getByRole('separator', { name: 'New' })).toBeInTheDocument()
      await act(async () => finishPage?.('exhausted'))
    })
  })
})
