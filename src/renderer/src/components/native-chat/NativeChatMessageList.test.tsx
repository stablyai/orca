// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

afterEach(cleanup)

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Selectable agent response.' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'ready',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

describe('NativeChatMessageList assistant messages', () => {
  it('keeps prose selectable and places non-selectable controls after it', () => {
    render(
      <NativeChatMessageList
        session={session}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    const prose = screen.getByText('Selectable agent response.')
    const row = prose.closest('.group')
    const copyButton = screen.getByRole('button', { name: 'Copy message' })
    const controls = copyButton.parentElement

    expect(row).toHaveClass('select-text')
    expect(controls).toHaveClass('select-none', 'pointer-events-none', 'mt-1')
    expect(controls).not.toHaveClass('absolute')
    expect(prose.compareDocumentPosition(controls!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
