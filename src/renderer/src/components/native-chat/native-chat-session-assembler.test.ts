import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
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

  it('sorts stably by timestamp then id for out-of-order appends', () => {
    const a = msg({ id: 'b', timestamp: 200, blocks: [{ type: 'text', text: 'four' }] })
    const b = msg({ id: 'a', timestamp: 100, blocks: [{ type: 'text', text: 'one' }] })
    const c = msg({ id: 'a2', timestamp: 100, blocks: [{ type: 'text', text: 'three' }] })
    const d = msg({ id: 'a1', timestamp: 100, blocks: [{ type: 'text', text: 'two' }] })

    const session = assembleNativeChatSession({
      sources: { transcript: [a, b, c, d] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages.map((m) => m.id)).toEqual(['a', 'a1', 'a2', 'b'])
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

  it('merges Claude image source marker records into the following user prompt', () => {
    const imageSource = msg({
      id: 'u-image-source',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /Users/me/Downloads/3d.png]' }]
    })
    const prompt = msg({
      id: 'u-prompt',
      role: 'user',
      timestamp: 101,
      blocks: [{ type: 'text', text: '[Image #1] what do you see' }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [imageSource, prompt] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({ id: 'u-prompt', role: 'user' })
    expect(session.messages[0].blocks).toEqual([
      { type: 'image-ref', path: '/Users/me/Downloads/3d.png' },
      { type: 'text', text: 'what do you see' }
    ])
  })

  it('drops a scrape duplicate even when scrape is processed first by id', () => {
    const scrape = msg({
      id: 'shared-id',
      source: 'scrape',
      turnId: 't9',
      timestamp: 10
    })
    const transcript = msg({
      id: 'shared-id',
      source: 'transcript',
      turnId: 't9',
      timestamp: 10
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [transcript], scrape: [scrape] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].source).toBe('transcript')
  })

  it('assembles an empty session to status empty without throwing', () => {
    const session = assembleNativeChatSession({
      sources: {},
      sessionId: null,
      agent: 'claude'
    })

    expect(session.messages).toEqual([])
    expect(session.status).toBe('empty')
    expect(session.sessionId).toBeNull()
  })

  it('honors an explicit status override', () => {
    const session = assembleNativeChatSession({
      sources: {},
      sessionId: null,
      agent: 'claude',
      status: 'loading'
    })
    expect(session.status).toBe('loading')
  })

  it('keeps two distinct tool-call-only same-role messages (no turnId, no text)', () => {
    const first = msg({
      id: 'tc-1',
      role: 'assistant',
      timestamp: 100,
      blocks: [{ type: 'tool-call', name: 'read', input: { path: 'a.txt' } }]
    })
    const second = msg({
      id: 'tc-2',
      role: 'assistant',
      timestamp: 200,
      blocks: [{ type: 'tool-call', name: 'read', input: { path: 'b.txt' } }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [first, second] },
      sessionId: 's1',
      agent: 'claude'
    })

    // Different tool inputs digest to different turn keys, so neither is dropped.
    expect(session.messages.map((m) => m.id)).toEqual(['tc-1', 'tc-2'])
  })

  it('keeps two identical consecutive user prompts (distinct ids) — #10', () => {
    // Same role, identical text, distinct ids: two genuinely distinct turns that
    // happen to share a prompt. Same source (transcript), so the text fallback
    // must NOT collapse them.
    const first = msg({
      id: 'u-1',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'run the tests' }]
    })
    const second = msg({
      id: 'u-2',
      role: 'user',
      timestamp: 200,
      blocks: [{ type: 'text', text: 'run the tests' }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [first, second] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages.map((m) => m.id)).toEqual(['u-1', 'u-2'])
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

  it('still collapses a cross-source same turn by text+timestamp, transcript wins', () => {
    const hook = msg({
      id: 'hook-1',
      source: 'hook',
      role: 'assistant',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'the answer' }]
    })
    const transcript = msg({
      id: 'transcript-1',
      source: 'transcript',
      role: 'assistant',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'the answer' }]
    })

    const session = assembleNativeChatSession({
      sources: { transcript: [transcript], hook: [hook] },
      sessionId: 's1',
      agent: 'claude'
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].source).toBe('transcript')
  })

  it('carries an error message when provided', () => {
    const session = assembleNativeChatSession({
      sources: {},
      sessionId: null,
      agent: 'claude',
      status: 'error',
      error: 'transcript unreadable'
    })
    expect(session.status).toBe('error')
    expect(session.error).toBe('transcript unreadable')
  })
})
