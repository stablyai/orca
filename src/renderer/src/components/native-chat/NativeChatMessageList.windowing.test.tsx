// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'

import {
  deliverResizes,
  list,
  marker,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver,
  TRANSCRIPT_LENGTH,
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

    const header = screen.getByRole('button', { name: /^ls/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    expect(screen.getByRole('button', { name: /^ls/ })).toHaveAttribute('aria-expanded', 'true')

    scrollTranscript(container, 5000)
    expect(windowState(container).indexes).not.toContain(1)
    expect(screen.queryByRole('button', { name: /^ls/ })).toBeNull()

    scrollTranscript(container, 0)
    expect(screen.getByRole('button', { name: /^ls/ })).toHaveAttribute('aria-expanded', 'true')
  })
})

// Diff reveals name and pin an earlier, possibly unmounted message until its card can answer.
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

  it('opens an old edit inline at the visible turn outcome without mounting its source row', () => {
    const scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    const { container } = render(
      <NativeChatMessageList
        session={session(projectStructuredItemsToNativeChat(items))}
        journalItems={items}
        isWorking={false}
        expandSignal={false}
      />
    )
    // The pinned tail holds the rollup; its target diff has scrolled out of the window.
    scrollTranscript(container, 4000)
    expect(screen.queryByRole('button', { name: /^Edited .*a\.ts(?:\s|$)/ })).toBeNull()
    const mountedBefore = windowState(container).indexes.length

    scrollTo.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))

    expect(screen.getByText('Edited')).toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
    expect(scrollTo).not.toHaveBeenCalled()
    // The outcome reuses the bounded transcript window.
    expect(windowState(container).indexes.length).toBeLessThanOrEqual(mountedBefore + 2)
  })
})

describe('transcript with a hidden scroll root', () => {
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
