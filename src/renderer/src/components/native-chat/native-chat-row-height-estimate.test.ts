import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { nativeChatRowContentMetrics } from './native-chat-row-height-estimate'

function message(text: string, role: NativeChatMessage['role'] = 'assistant'): NativeChatMessage {
  return {
    id: `m-${text.length}`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('transcript row height estimate', () => {
  it('keeps role-specific chrome when two messages share their blocks', () => {
    const blocks: NativeChatMessage['blocks'] = [{ type: 'text', text: 'same content' }]
    const withRole = (role: NativeChatMessage['role']): NativeChatMessage => ({
      ...message('same content', role),
      blocks
    })

    expect(nativeChatRowContentMetrics(withRole('user')).role).toBe('user')
    expect(nativeChatRowContentMetrics(withRole('assistant')).role).toBe('assistant')
  })
})
