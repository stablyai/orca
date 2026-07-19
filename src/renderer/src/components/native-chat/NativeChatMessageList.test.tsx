// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

function liveSession(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'sess',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => {}
  }
}

function renderList(messages: NativeChatMessage[]): void {
  render(
    <NativeChatMessageList
      session={liveSession(messages)}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

const reasoningMessage: NativeChatMessage = {
  id: 'r-1',
  role: 'reasoning',
  blocks: [{ type: 'text', text: 'pondering the fix quietly' }],
  timestamp: 1,
  source: 'transcript'
}

describe('NativeChatMessageList reasoning rows', () => {
  afterEach(cleanup)

  it('collapses reasoning to a disclosure line by default', () => {
    renderList([reasoningMessage])

    const disclosure = screen.getByRole('button', { name: /Thinking/ })
    expect(disclosure).toBeInTheDocument()
    // The full reasoning body (markdown paragraph) is unmounted until expanded;
    // only the one-line preview inside the disclosure shows.
    expect(
      screen.queryByText('pondering the fix quietly', { selector: 'p' })
    ).not.toBeInTheDocument()
    expect(disclosure).toHaveTextContent('pondering the fix quietly')
  })

  it('expands and re-collapses the reasoning body on click', () => {
    renderList([reasoningMessage])

    const disclosure = screen.getByRole('button', { name: /Thinking/ })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('pondering the fix quietly', { selector: 'p' })).toBeInTheDocument()

    fireEvent.click(disclosure)
    expect(
      screen.queryByText('pondering the fix quietly', { selector: 'p' })
    ).not.toBeInTheDocument()
  })

  it('keeps assistant prose rendered in full, not collapsed', () => {
    renderList([
      {
        id: 'a-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'the actual answer' }],
        timestamp: 1,
        source: 'transcript'
      }
    ])

    expect(screen.getByText('the actual answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Thinking/ })).not.toBeInTheDocument()
  })
})
