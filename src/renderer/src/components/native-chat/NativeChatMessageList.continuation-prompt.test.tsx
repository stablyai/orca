// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CONTINUATION_PROMPT_LEAD } from '@/lib/agent-session-continuation'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

afterEach(cleanup)

const continuationText = [
  AGENT_SESSION_CONTINUATION_PROMPT_LEAD,
  'The prior provider session is read-only context; do not resume or modify it.',
  '',
  'Original agent: grok',
  'Orca pane: 2.1'
].join('\n')

function sessionWithUserText(text: string): NativeChatLiveSession {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text }],
        timestamp: 1,
        source: 'transcript'
      }
    ],
    status: 'ready',
    sessionId: 'session-1',
    agent: 'grok',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

describe('NativeChatMessageList continuation prompts', () => {
  it('keeps replacement messages after retained history when the provider omits timestamps', () => {
    const session = sessionWithUserText('Prior conversation')
    session.messages.push({
      id: 'new-answer',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Replacement response' }],
      timestamp: null,
      source: 'transcript'
    })
    const { container } = render(
      <NativeChatMessageList
        session={session}
        preserveMessageOrder
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
    expect(container.textContent!.indexOf('Prior conversation')).toBeLessThan(
      container.textContent!.indexOf('Replacement response')
    )
  })
  it('hides the prior-session prompt behind an expandable summary', () => {
    render(
      <NativeChatMessageList
        session={sessionWithUserText(continuationText)}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    const summary = screen.getByRole('button', { name: 'Continue from prior session' })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Original agent: grok/)).toBeNull()

    fireEvent.click(summary)
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Original agent: grok/)).toBeVisible()
  })

  it('keeps ordinary user prompts fully visible', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWithUserText('Ship the picker search')}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(container.querySelector('details')).toBeNull()
    expect(screen.getByText('Ship the picker search')).toBeVisible()
  })
})
