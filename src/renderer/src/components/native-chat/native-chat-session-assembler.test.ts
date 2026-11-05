import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { assembleNativeChatSession } from './native-chat-session-assembler'

function msg(
  overrides: Partial<NativeChatMessage> & Pick<NativeChatMessage, 'id'>
): NativeChatMessage {
  return {
    role: 'assistant',
    blocks: [{ type: 'text', text: '' }],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

describe('assembleNativeChatSession', () => {
  it('collapses the same turn from hook + transcript to one message, transcript wins', () => {
    const hook = msg({
      id: 'hook-1',
      source: 'hook',
      turnId: 't1',
      blocks: [{ type: 'text', text: 'partial...' }],
      timestamp: 100
    })
    const transcript = msg({
      id: 'transcript-1',
      source: 'transcript',
      turnId: 't1',
      blocks: [{ type: 'text', text: 'final answer' }],
      timestamp: 100
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [transcript], hook: [hook] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].source).toBe('transcript')
    expect(session.messages[0].blocks).toEqual([{ type: 'text', text: 'final answer' }])
    expect(session.status).toBe('ready')
  })

  it('drops a scrape message when a transcript message covers the same turn', () => {
    const scrape = msg({
      id: 'scrape-1',
      source: 'scrape',
      role: 'user',
      blocks: [{ type: 'text', text: 'Run the tests' }],
      timestamp: null
    })
    const transcript = msg({
      id: 'transcript-1',
      source: 'transcript',
      role: 'user',
      blocks: [{ type: 'text', text: 'run the   tests' }],
      timestamp: 50
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [transcript], scrape: [scrape] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].source).toBe('transcript')
  })

  it('does not duplicate an image ref the prompt already has when companions follow it', () => {
    const prompt = msg({
      id: 'a-prompt',
      role: 'user',
      timestamp: 100,
      blocks: [
        { type: 'image-ref', path: '/tmp/a.png' },
        { type: 'text', text: '[Image #1] [Image #2] caption' }
      ]
    })
    const kept = msg({
      id: 'm-kept',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }]
    })
    const added = msg({
      id: 'z-added',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/b.png]' }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [prompt, kept, added] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'image-ref', path: '/tmp/b.png' },
      { type: 'text', text: 'caption' }
    ])
  })

  it('keeps distinct equal-timestamp image companions with their adjacent prompts', () => {
    const firstPrompt = msg({
      id: 'a-first-prompt',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image #1] inspect the first' }]
    })
    const firstCompanion = msg({
      id: 'z-first-companion',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/first.png]' }]
    })
    const secondPrompt = msg({
      id: 'b-second-prompt',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image #1] inspect the second' }]
    })
    const secondCompanion = msg({
      id: 'y-second-companion',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/second.png]' }]
    })

    const session = assembleNativeChatSession({
      sources: {
        transcript: [firstPrompt, firstCompanion, secondPrompt, secondCompanion]
      },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages).toEqual([
      {
        ...firstPrompt,
        blocks: [
          { type: 'image-ref', path: '/tmp/first.png' },
          { type: 'text', text: 'inspect the first' }
        ]
      },
      {
        ...secondPrompt,
        blocks: [
          { type: 'image-ref', path: '/tmp/second.png' },
          { type: 'text', text: 'inspect the second' }
        ]
      }
    ])
  })

  it('does not move a following companion ahead of the prompt when both timestamps are missing', () => {
    const prompt = msg({
      id: 'a-prompt',
      role: 'user',
      timestamp: null,
      blocks: [{ type: 'text', text: '[Image #1] what do you see' }]
    })
    const companion = msg({
      id: 'z-companion',
      role: 'user',
      timestamp: null,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/3d.png]' }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [prompt, companion] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages.map((message) => message.id)).toEqual(['a-prompt', 'z-companion'])
    expect(session.messages[0]?.blocks).toEqual([{ type: 'text', text: 'what do you see' }])
    expect(session.messages[1]?.blocks).toEqual([{ type: 'image-ref', path: '/tmp/3d.png' }])
  })

  it('does not move an equal-timestamp companion across an unrelated row', () => {
    const prompt = msg({
      id: 'a-prompt',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image #1] inspect this' }]
    })
    const unrelated = msg({
      id: 'm-answer',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'unrelated' }]
    })
    const companion = msg({
      id: 'z-companion',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/image.png]' }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [prompt, unrelated, companion] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages.map((message) => message.id)).toEqual([
      'a-prompt',
      'm-answer',
      'z-companion'
    ])
    expect(session.messages[0]?.blocks).toEqual([{ type: 'text', text: 'inspect this' }])
    expect(session.messages[2]?.blocks).toEqual([{ type: 'image-ref', path: '/tmp/image.png' }])
  })

  it('keeps identical same-source prompts even at the SAME timestamp — #10', () => {
    const first = msg({
      id: 'u-1',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'go' }]
    })
    const second = msg({
      id: 'u-2',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'go' }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [first, second] },
      sessionId: 's1',
      agent: 'claude'
    })

    // Same source, so the source-gate keeps both even though text+timestamp match.
    expect(session.messages.map((m) => m.id).sort()).toEqual(['u-1', 'u-2'])
  })
})
