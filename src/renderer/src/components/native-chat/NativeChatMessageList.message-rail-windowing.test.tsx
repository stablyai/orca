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
  TRANSCRIPT_LENGTH,
  list,
  marker,
  scrollTranscript,
  session,
  stubLayout,
  windowState
} from './NativeChatMessageList.windowing-test-support'

afterEach(cleanup)

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
// outranks a later reveal, and slots is rebuilt every render, so an effect that
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
