// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import {
  deliverResizes,
  layout,
  marker,
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

/** A transcript of rows the journal placed, as a structured chat's are. */
function chat(
  length: number,
  isVisible: boolean,
  {
    ref,
    readCurrent = true
  }: { ref?: React.Ref<NativeChatMessageListHandle>; readCurrent?: boolean } = {}
): React.JSX.Element {
  const messages: NativeChatMessage[] = Array.from({ length }, (_, index) => ({
    ...marker(index),
    journalPosition: { sequence: index + 1, index: 0 }
  }))
  return (
    <NativeChatMessageList
      ref={ref}
      session={{ ...session(messages), readCurrent }}
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
    /** The pane is hidden and shown again; the read catches up after the reveal has put the
     *  reader's place back. */
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

    // A reply is drawn short and revealed over the frames after it arrives.
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
  })
})
