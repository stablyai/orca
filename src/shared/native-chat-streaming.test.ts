import { describe, expect, it } from 'vitest'
import {
  deriveNativeChatStreamingText,
  nativeChatOverlayLeadsTranscriptContent,
  nativeChatOverlayLeadsTranscriptReasoning,
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
const reasoning = (text: string): NativeChatMessage => ({
  id: `r-${text.length}`,
  role: 'reasoning',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})
const tool = (): NativeChatMessage => ({
  id: 'tool-1',
  role: 'tool',
  blocks: [],
  timestamp: null,
  source: 'transcript'
})

describe('deriveNativeChatStreamingText', () => {
  it('drops an overlay already covered by assistant text before a tool result', () => {
    expect(
      nativeChatOverlayLeadsTranscriptContent({
        messages: [assistant('Checking the workspace'), tool()],
        overlayText: 'Checking...'
      })
    ).toBe(false)
  })

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

  it('drops a preview flagged as tool output even when it leads the transcript', () => {
    // Regression: providers publish a tool's stdout as `lastAssistantMessage` for status
    // cards. It leads every transcript assistant turn and never appears in one, so without
    // this gate it rendered as the reply and no catch-up rule could ever retire it.
    expect(
      deriveNativeChatStreamingText({
        messages: [assistant('Partial')],
        previewText: 'Exit code 1\nimport { Foo } from "./foo"\nexport function bar() {}',
        working: true,
        previewIsToolOutput: true
      })
    ).toBeNull()
  })

  it('still shows a leading preview when it is not tool output', () => {
    expect(
      deriveNativeChatStreamingText({
        messages: [assistant('Partial')],
        previewText: 'Partial answer that is now much longer than before',
        working: true,
        previewIsToolOutput: false
      })
    ).toBe('Partial answer that is now much longer than before')
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

describe('nativeChatOverlayLeadsTranscriptReasoning', () => {
  it('leads an empty transcript', () => {
    expect(
      nativeChatOverlayLeadsTranscriptReasoning({ messages: [], overlayText: 'thinking hard' })
    ).toBe(true)
  })

  it('does not lead against the transcript assistant answer — only its reasoning row counts', () => {
    // Root cause: comparing thinking prose against assistant prose never
    // matches, so it always "leads" and never retires. Even though the
    // assistant row is present here, absence of a reasoning row means still
    // leading (the overlay must keep showing, not falsely retire against
    // unrelated prose).
    expect(
      nativeChatOverlayLeadsTranscriptReasoning({
        messages: [assistant('thinking hard about the answer')],
        overlayText: 'thinking hard'
      })
    ).toBe(true)
  })

  it('drops once the transcript reasoning row contains the overlay text, reasoning row not last', () => {
    // Transcript order for a settled turn: reasoning row, then the reply —
    // the reasoning row is never the literal last message.
    expect(
      nativeChatOverlayLeadsTranscriptReasoning({
        messages: [reasoning('thinking hard about it'), assistant('the answer')],
        overlayText: 'thinking hard'
      })
    ).toBe(false)
  })

  it('does not match a stale reasoning row from a prior turn once a new turn boundary lands', () => {
    const optimisticEcho = { ...user('new question'), id: 'pending:1', source: 'scrape' as const }
    expect(
      nativeChatOverlayLeadsTranscriptReasoning({
        messages: [
          reasoning('a long stale reasoning paragraph from the previous turn'),
          assistant('previous answer'),
          optimisticEcho
        ],
        overlayText: 'ab'
      })
    ).toBe(true)
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
