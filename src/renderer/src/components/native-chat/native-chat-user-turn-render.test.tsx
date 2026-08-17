import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

function sessionOf(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 's1',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => {},
    readPhase: 'ready'
  }
}

function userTurn(text: string): NativeChatMessage {
  return {
    id: 'u1',
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

function renderedText(text: string): string {
  return renderToStaticMarkup(
    <NativeChatMessageList
      session={sessionOf([userTurn(text)])}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  ).replace(/<[^>]*>/g, '')
}

describe('user turn rendering', () => {
  // Wiring guard: the row must opt out of link reference definitions, or a
  // marker line the transcript rules deliberately preserved still renders as
  // an empty bubble.
  it.each([
    '[Image #1]: /tmp/a.png',
    '- [Image #1]: /tmp/a.png',
    '> [Image #1]: /tmp/a.png',
    '[Image #1\nstill mine]: /tmp/a.png'
  ])('shows a definition-shaped user line on screen', (typed) => {
    expect(renderedText(typed)).toContain('[Image #1')
  })

  it('shows a literal marker the user typed without an attachment', () => {
    expect(renderedText('keep [Image #1] literal')).toContain('keep [Image #1] literal')
  })
})
