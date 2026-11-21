import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatRowCopyText } from './native-chat-message-copy-text'

const start: NativeChatMessage = {
  id: 's',
  role: 'system',
  source: 'transcript',
  timestamp: 1,
  blocks: [{ type: 'text', text: 'Check the release build.' }],
  agentStart: true,
  agentStartDispatchId: 'd1',
  from: {
    kind: 'agent',
    orchestration: null,
    senders: [
      { party: { address: 'term_w', terminalHandle: 'term_w', orcaSessionId: null }, name: 'Fix' }
    ]
  }
}

describe('copying a Started row joined to its item link', () => {
  it('copies the row as it reads, then the task', () => {
    expect(
      nativeChatRowCopyText({
        ...start,
        agentStartItems: [{ uid: 'p0', number: 1, title: 'P0', status: 'working' }]
      })
    ).toBe('Started Fix for P0\n\nCheck the release build.')
  })
})
