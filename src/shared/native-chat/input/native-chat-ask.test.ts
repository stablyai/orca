import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { scanPendingAsks } from './native-chat-ask'

function asyncQuestion(id: string, callId: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        callId,
        input: { questions: [{ title: 'Which report?', options: ['Weekly', 'Monthly'] }] }
      }
    ]
  }
}

it('keeps an answered call closed when compaction history includes it again', () => {
  const history: NativeChatMessage[] = [
    asyncQuestion('original', 'call-1'),
    {
      id: 'answer',
      role: 'user',
      timestamp: null,
      source: 'transcript',
      blocks: [{ type: 'text', text: '> Which report?\n\nWeekly' }]
    },
    {
      id: 'compacted',
      role: 'system',
      timestamp: null,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }]
    },
    asyncQuestion('replayed', 'call-1')
  ]

  expect(scanPendingAsks(history).contributors).toEqual([])
  expect(
    scanPendingAsks([...history, asyncQuestion('asked-again', 'call-2')]).contributors.map(
      (question) => question.sourceRowId
    )
  ).toEqual(['asked-again'])
})
