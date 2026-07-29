import { describe, expect, it } from 'vitest'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage,
  NATIVE_CHAT_STREAMING_ID
} from './native-chat-streaming'
import type { NativeChatMessage } from './native-chat-types'

const assistant = (text: string): NativeChatMessage => ({
  id: `a-${text.length}`,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})
const user = (text: string): NativeChatMessage => ({
  id: `u-${text.length}`,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

describe('deriveNativeChatStreamingText', () => {
  it('returns null when not working (stale preview never shows)', () => {
    expect(
      deriveNativeChatStreamingText({ messages: [], previewText: 'Hello there', working: false })
    ).toBeNull()
  })

  it('returns null for empty / whitespace preview', () => {
    expect(
      deriveNativeChatStreamingText({ messages: [], previewText: '', working: true })
    ).toBeNull()
    expect(
      deriveNativeChatStreamingText({ messages: [], previewText: '   ', working: true })
    ).toBeNull()
  })

  it('shows the preview while it leads an empty/user-tailed transcript', () => {
    expect(
      deriveNativeChatStreamingText({
        messages: [user('do the thing')],
        previewText: 'Working on it',
        working: true
      })
    ).toBe('Working on it')
  })

  it('treats an optimistic user echo as the active streaming-turn boundary', () => {
    const optimistic = {
      ...user('new prompt'),
      id: 'pending:send-1',
      timestamp: 20,
      source: 'scrape' as const
    }
    expect(
      deriveNativeChatStreamingText({
        messages: [assistant('A much longer answer from the completed prior turn'), optimistic],
        previewText: 'New reply',
        working: true
      })
    ).toBe('New reply')
  })

  it('drops the preview once the real assistant turn contains it (no duplicate)', () => {
    expect(
      deriveNativeChatStreamingText({
        messages: [assistant('Working on it, here is the full answer.')],
        previewText: 'Working on it',
        working: true
      })
    ).toBeNull()
  })

  it('drops the preview when it is not longer than the last assistant turn (no flicker)', () => {
    expect(
      deriveNativeChatStreamingText({
        messages: [assistant('Same length text')],
        previewText: 'Same length text',
        working: true
      })
    ).toBeNull()
  })

  it('keeps showing while the preview still leads (grows past the last turn)', () => {
    // The transcript hasn't flushed the new content yet; preview is longer.
    expect(
      deriveNativeChatStreamingText({
        messages: [assistant('Partial')],
        previewText: 'Partial answer that is now much longer than before',
        working: true
      })
    ).toBe('Partial answer that is now much longer than before')
  })
})

describe('nativeChatStreamingMessage', () => {
  it('builds a stable-id assistant hook message', () => {
    const m = nativeChatStreamingMessage('hi')
    expect(m.id).toBe(NATIVE_CHAT_STREAMING_ID)
    expect(m.role).toBe('assistant')
    expect(m.source).toBe('hook')
    expect(m.blocks).toEqual([{ type: 'text', text: 'hi' }])
  })
})
