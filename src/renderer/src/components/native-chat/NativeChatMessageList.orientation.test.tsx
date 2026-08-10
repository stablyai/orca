// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

function message(id: string, text: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function session(overrides: Partial<NativeChatLiveSession> = {}): NativeChatLiveSession {
  return {
    messages: [
      message('m1', 'oldest turn', 1),
      message('m2', 'middle turn', 2),
      message('m3', 'newest turn', 3)
    ],
    status: 'ready',
    sessionId: 'session-1',
    agent: 'droid',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready',
    ...overrides
  }
}

function renderedTurnOrder(): string[] {
  return screen
    .getAllByText(/turn$/)
    .map((node) => node.textContent ?? '')
    .filter((text) => text.endsWith('turn'))
}

describe('NativeChatMessageList orientation', () => {
  afterEach(cleanup)

  it('reads oldest to newest by default', () => {
    render(
      <NativeChatMessageList
        session={session()}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(renderedTurnOrder()).toEqual(['oldest turn', 'middle turn', 'newest turn'])
  })

  // The whole point of the composer-on-top layout: the newest turn renders
  // adjacent to the input instead of a scroll-height away from it.
  it('puts the newest turn first when the composer is on top', () => {
    render(
      <NativeChatMessageList
        session={session()}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        orientation="newest-first"
      />
    )

    expect(renderedTurnOrder()).toEqual(['newest turn', 'middle turn', 'oldest turn'])
  })

  it('keeps the paging control on the oldest edge in both orientations', () => {
    const withHistory = session({ hasMore: true })
    const { rerender } = render(
      <NativeChatMessageList
        session={withHistory}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
    const loadEarlier = screen.getByRole('button', { name: 'Load earlier messages' })
    const oldest = screen.getByText('oldest turn')
    // DOM order mirrors paint order in both layouts, so comparing positions is
    // enough: the control precedes the oldest turn when reading downward…
    expect(loadEarlier.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    rerender(
      <NativeChatMessageList
        session={withHistory}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        orientation="newest-first"
      />
    )
    // …and follows it when the newest turn is rendered first.
    const reversedControl = screen.getByRole('button', { name: 'Load earlier messages' })
    const reversedOldest = screen.getByText('oldest turn')
    expect(
      reversedControl.compareDocumentPosition(reversedOldest) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING)
  })

  it('points the jump affordance at whichever edge holds the newest turn', () => {
    const { container, rerender } = render(
      <NativeChatMessageList
        session={session()}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        orientation="newest-first"
      />
    )
    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    // Padding belongs to the oldest edge; the newest edge abuts the composer.
    expect(scroller).toHaveClass('pb-10')
    expect(scroller).not.toHaveClass('pt-10')

    rerender(
      <NativeChatMessageList
        session={session()}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
    expect(container.querySelector('.overflow-y-auto')).toHaveClass('pt-10')
  })
})
