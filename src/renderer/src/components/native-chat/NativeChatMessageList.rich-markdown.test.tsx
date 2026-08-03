// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

function createSession(): NativeChatLiveSession {
  return {
    agent: 'codex',
    sessionId: 'session-1',
    status: 'ready',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => {},
    readPhase: 'ready',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 1,
        source: 'transcript',
        blocks: [{ type: 'text', text: '## Task\n\nExplain $E = mc^2$.' }]
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 2,
        source: 'transcript',
        blocks: [
          {
            type: 'text',
            text: [
              '## Energy model',
              '',
              'Inline $E = mc^2$ and the corresponding display equation:',
              '',
              '$$',
              '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
              '$$',
              '',
              '| Term | Value |',
              '| --- | --- |',
              '| Energy | $E$ |',
              '',
              '```ts',
              'const energy = mass * speedOfLight ** 2',
              '```'
            ].join('\n')
          }
        ]
      }
    ]
  }
}

describe('NativeChatMessageList rich Markdown', () => {
  afterEach(() => cleanup())

  it('renders Markdown, code, tables, and KaTeX together in the semantic transcript', () => {
    render(
      <NativeChatMessageList
        session={createSession()}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByRole('heading', { name: 'Task' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Energy model' })).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('const energy = mass * speedOfLight ** 2')).toBeInTheDocument()
    expect(document.querySelector('.katex-display')).toBeInTheDocument()
    expect(document.querySelectorAll('.katex')).toHaveLength(4)
  })
})
