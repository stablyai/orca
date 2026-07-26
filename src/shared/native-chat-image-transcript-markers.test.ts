import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'

function userText(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('normalizeImageTranscriptMessages', () => {
  it('merges the paired [Image: source]/[Image #1] turns into one image-ref turn', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/orca-paste-1-2.png]'),
      userText('b', '[Image #1] describe this')
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/orca-paste-1-2.png' },
      { type: 'text', text: 'describe this' }
    ])
  })

  it('does not merge a prompt with a later image-only send without a shared boundary', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image #1] describe this'),
      userText('b', '[Image: source: /tmp/orca-paste-1-2.png]')
    ])
    expect(out).toHaveLength(2)
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'describe this' }])
    expect(out[1]!.blocks).toEqual([{ type: 'image-ref', path: '/tmp/orca-paste-1-2.png' }])
  })

  it('merges consecutive image sources with their caption into one user turn', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/a.png]'),
      userText('b', '[Image: source: /tmp/b.png]'),
      userText('c', '[Image #1] compare these')
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'image-ref', path: '/tmp/b.png' },
      { type: 'text', text: 'compare these' }
    ])
  })

  it('converts a lone [Image: source] turn (no prompt) into an image-ref instead of raw text', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /Users/me/Pictures/hero-image-2.png]')
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/Users/me/Pictures/hero-image-2.png' }
    ])
  })

  it('leaves ordinary user text untouched', () => {
    const out = normalizeImageTranscriptMessages([userText('a', 'how about this')])
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'how about this' }])
  })

  it('leaves assistant messages untouched', () => {
    const assistant: NativeChatMessage = {
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'text', text: '[Image: source: /tmp/x.png]' }],
      timestamp: 1,
      source: 'transcript'
    }
    expect(normalizeImageTranscriptMessages([assistant])).toEqual([assistant])
  })
})
