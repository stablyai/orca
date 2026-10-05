// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  nativeChatAsyncCallsFolded,
  type NativeChatAsyncCallsFolded
} from '../../../../shared/native-chat-async-questions'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatTranscriptProjection } from './use-native-chat-transcript-projection'

afterEach(cleanup)

const messages: NativeChatMessage[] = [
  {
    id: 'a1',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'Which name?' },
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        input: '{"questions":[{"title":"Which name?","options":["core","base"]}]}',
        callId: 'call-1'
      }
    ],
    timestamp: 1,
    source: 'transcript'
  }
]

const session: NativeChatLiveSession = {
  messages,
  status: 'ready',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

type Props = { folded: NativeChatAsyncCallsFolded | undefined }

it('folds away the async question calls its view says the card answers', () => {
  const onCard: Props = {
    folded: nativeChatAsyncCallsFolded({
      state: 'ready',
      questions: [{ key: '["request_user_input_async","call-1",0]', index: 0, title: 'Q' }]
    })
  }
  const hook = renderHook(
    ({ folded }: Props) => useNativeChatTranscriptProjection(session, undefined, undefined, folded),
    { initialProps: onCard }
  )
  expect(JSON.stringify(hook.result.current.messages)).not.toContain('request_user_input_async')
  // No card to answer them (an older host, or the card can't show): the row and options stay.
  hook.rerender({ folded: undefined })
  expect(JSON.stringify(hook.result.current.messages)).toContain('base')
})
