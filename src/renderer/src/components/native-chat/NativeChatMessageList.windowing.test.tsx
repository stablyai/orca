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
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'
import { NATIVE_CHAT_ROW_GAP_PX } from './native-chat-row-height-estimate'
import {
  deliverResizes,
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

function scrollRoot(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  return scroller
}

/** Deliver resize and scroll events to a fixed point, as a painted frame would. */
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

async function settleVirtualizer(container: HTMLElement): Promise<void> {
  for (let frame = 0; frame < 2; frame += 1) {
    paint(container)
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
  }
  paint(container)
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

  it('preserves a detached viewport when messages append while hidden', async () => {
    let isVisible = true
    const restoreLayout = stubLayout({
      scrollGeometry: true,
      isVisible: () => isVisible
    })
    const restoreResizeObserver = stubResizeObserver()
    const initialMessages = Array.from({ length: 120 }, (_, index) => marker(index))
    const appendedMessages = [
      ...initialMessages,
      ...Array.from({ length: 20 }, (_, index) => marker(120 + index))
    ]
    try {
      const { container, rerender } = render(list(initialMessages, isVisible))
      await settleVirtualizer(container)

      const scroller = scrollRoot(container)
      const readingAt = 2_000
      scrollTranscript(container, readingAt)
      await settleVirtualizer(container)
      expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()

      isVisible = false
      rerender(list(initialMessages, isVisible))
      await settleVirtualizer(container)
      const scrollTo = vi.spyOn(scroller, 'scrollTo')
      try {
        rerender(list(appendedMessages, isVisible))
        await settleVirtualizer(container)
        expect(scrollTo).not.toHaveBeenCalled()
      } finally {
        scrollTo.mockRestore()
      }

      isVisible = true
      rerender(list(appendedMessages, isVisible))
      await settleVirtualizer(container)

      expect(scroller.scrollTop).toBe(readingAt)
      expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
    } finally {
      restoreResizeObserver()
      restoreLayout()
    }
  })

  it('preserves a detached viewport when a structured session catches up after reveal', async () => {
    let isVisible = true
    const restoreLayout = stubLayout({
      scrollGeometry: true,
      isVisible: () => isVisible
    })
    const restoreResizeObserver = stubResizeObserver()
    const initialMessages = Array.from({ length: 120 }, (_, index) => marker(index))
    const appendedMessages = [
      ...initialMessages,
      ...Array.from({ length: 20 }, (_, index) => marker(120 + index))
    ]
    try {
      const { container, rerender } = render(list(initialMessages, isVisible))
      await settleVirtualizer(container)

      const scroller = scrollRoot(container)
      const readingAt = 2_000
      scrollTranscript(container, readingAt)
      await settleVirtualizer(container)
      expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()

      isVisible = false
      rerender(list(initialMessages, isVisible))
      await settleVirtualizer(container)
      isVisible = true
      rerender(list(initialMessages, isVisible))
      // The resumed transport can publish catch-up before the reveal write emits a scroll event.
      rerender(list(appendedMessages, isVisible))
      await settleVirtualizer(container)

      expect(scroller.scrollTop).toBe(readingAt)
      expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
    } finally {
      restoreResizeObserver()
      restoreLayout()
    }
  })

  it('catches a following viewport up after messages append while hidden', async () => {
    let isVisible = true
    const restoreLayout = stubLayout({
      scrollGeometry: true,
      isVisible: () => isVisible
    })
    const restoreResizeObserver = stubResizeObserver()
    const initialMessages = Array.from({ length: 120 }, (_, index) => marker(index))
    const appendedMessages = [
      ...initialMessages,
      ...Array.from({ length: 20 }, (_, index) => marker(120 + index))
    ]
    try {
      const { container, rerender } = render(list(initialMessages, isVisible))
      await settleVirtualizer(container)

      isVisible = false
      rerender(list(initialMessages, isVisible))
      await settleVirtualizer(container)
      rerender(list(appendedMessages, isVisible))
      await settleVirtualizer(container)

      isVisible = true
      rerender(list(appendedMessages, isVisible))
      await settleVirtualizer(container)

      const scroller = scrollRoot(container)
      expect(
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
      ).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
      expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
    } finally {
      restoreResizeObserver()
      restoreLayout()
    }
  })
})
