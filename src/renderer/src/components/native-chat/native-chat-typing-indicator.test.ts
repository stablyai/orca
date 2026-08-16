import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { shouldShowNativeChatTypingIndicator } from './native-chat-typing-indicator'

function message(id: string, role: NativeChatMessage['role'], text = id): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

describe('shouldShowNativeChatTypingIndicator', () => {
  it('stays hidden when the session is idle', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user')],
        isWorking: false
      })
    ).toBe(false)
  })

  it('shows once a send lands and no assistant row exists yet', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('a0', 'assistant'), message('u1', 'user')],
        isWorking: true
      })
    ).toBe(true)
  })

  it('hides as soon as the structured reply row arrives, before working clears', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user'), message('orca-item', 'assistant')],
        isWorking: true
      })
    ).toBe(false)
  })

  it('hides behind the PTY streaming bubble', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user'), message(NATIVE_CHAT_STREAMING_ID, 'assistant')],
        isWorking: true
      })
    ).toBe(false)
  })

  it('does not flicker back on when a system row interleaves mid-turn', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [
          message('u1', 'user'),
          message('a1', 'assistant'),
          message('s1', 'system', 'Ran /status')
        ],
        isWorking: true
      })
    ).toBe(false)
  })

  it('shows again for the next send even though an earlier turn replied', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user')],
        isWorking: true
      })
    ).toBe(true)
  })

  it('shows after a slash-command marker even though an earlier turn replied', () => {
    expect(
      shouldShowNativeChatTypingIndicator({
        messages: [
          message('a1', 'assistant'),
          message('command:compact', 'system', 'Ran /compact')
        ],
        isWorking: true
      })
    ).toBe(true)
  })

  it('shows on a session whose transcript is still empty', () => {
    expect(shouldShowNativeChatTypingIndicator({ messages: [], isWorking: true })).toBe(true)
  })
})
