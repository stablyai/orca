// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NativeChatProseModule from './native-chat-prose'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

// Counting real per-row work rather than a render counter: a future refactor could keep the
// render count low while still re-deriving every row's markdown.
const proseCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('./native-chat-prose', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeChatProseModule>()
  return {
    ...actual,
    nativeChatProseToMarkdown: (prose: Parameters<typeof actual.nativeChatProseToMarkdown>[0]) => {
      proseCalls.count += 1
      return actual.nativeChatProseToMarkdown(prose)
    }
  }
})

const { NativeChatMessageList } = await import('./NativeChatMessageList')

afterEach(cleanup)

const TRANSCRIPT_LENGTH = 120

function settledMessages(): NativeChatMessage[] {
  return Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    blocks: [{ type: 'text' as const, text: `settled line ${index}` }],
    timestamp: index + 1,
    source: 'transcript' as const
  }))
}

function sessionWith(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

describe('native chat transcript re-render cost during a streaming turn', () => {
  it('rebuilds only the rows whose blocks changed, not the whole transcript per frame', () => {
    const messages = settledMessages()
    const { rerender } = render(
      <NativeChatMessageList
        session={sessionWith(messages)}
        isWorking={true}
        expandSignal={false}
        fontScale={1}
      />
    )

    const afterFirstPaint = proseCalls.count
    expect(afterFirstPaint).toBeGreaterThanOrEqual(TRANSCRIPT_LENGTH)

    // A streaming turn publishes a frame per SDK event; only the tail message's blocks change.
    const STREAM_FRAMES = 20
    for (let frame = 1; frame <= STREAM_FRAMES; frame += 1) {
      const streaming = messages.slice(0, -1).concat({
        ...messages.at(-1)!,
        blocks: [{ type: 'text' as const, text: `streaming token ${frame}` }]
      })
      rerender(
        <NativeChatMessageList
          session={sessionWith(streaming)}
          isWorking={true}
          expandSignal={false}
          fontScale={1}
        />
      )
    }

    const perFrame = (proseCalls.count - afterFirstPaint) / STREAM_FRAMES
    // Without row memoization every settled row rebuilt its markdown on every frame. Settled
    // rows keep their block identity, so only the streaming tail should rebuild.
    expect(perFrame).toBeLessThan(TRANSCRIPT_LENGTH / 10)
  })
})
