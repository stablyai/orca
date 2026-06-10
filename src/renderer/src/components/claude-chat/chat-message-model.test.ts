import { describe, it, expect } from 'vitest'
import { reduceChat, initialChatState, type ChatItem, type ChatAction } from './chat-message-model'

function feed(events: unknown[]): ReturnType<typeof initialChatState> {
  return events.reduce<ReturnType<typeof initialChatState>>(
    (s, e) => reduceChat(s, e as ChatAction),
    initialChatState()
  )
}

describe('reduceChat', () => {
  it('appends a local user message', () => {
    const s = reduceChat(initialChatState(), { kind: 'localUser', text: 'hello' })
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ role: 'user', text: 'hello' })
  })

  it('captures session id from system init', () => {
    const s = feed([
      {
        kind: 'event',
        event: { type: 'system', subtype: 'init', session_id: 'abc', model: 'claude' }
      }
    ])
    expect(s.sessionId).toBe('abc')
  })

  it('appends assistant text blocks', () => {
    const s = feed([
      {
        kind: 'event',
        event: { type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } }
      }
    ])
    const last = s.items.at(-1) as ChatItem
    expect(last).toMatchObject({ role: 'assistant', text: 'hi there' })
  })

  it('appends a tool_use item', () => {
    const s = feed([
      {
        kind: 'event',
        event: {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } }]
          }
        }
      }
    ])
    const last = s.items.at(-1) as ChatItem
    expect(last).toMatchObject({ role: 'tool_use', toolName: 'Read', toolUseId: 't1' })
  })

  it('attaches a tool_result to the matching tool_use', () => {
    const s = feed([
      {
        kind: 'event',
        event: {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }
        }
      },
      {
        kind: 'event',
        event: {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'file contents', is_error: false }
            ]
          }
        }
      }
    ])
    type ToolUseItem = Extract<ChatItem, { role: 'tool_use' }>
    const toolItem = s.items.find(
      (i): i is ToolUseItem => i.role === 'tool_use' && (i as ToolUseItem).toolUseId === 't1'
    )
    expect(toolItem?.result).toBe('file contents')
    expect(toolItem?.isError).toBe(false)
  })

  it('marks running false on result event', () => {
    const s = feed([
      { kind: 'localUser', text: 'q' },
      { kind: 'setRunning', running: true },
      { kind: 'event', event: { type: 'result', subtype: 'success', result: 'done' } }
    ])
    expect(s.running).toBe(false)
  })

  it('loadTranscript: one user text + one assistant -> 2 items, sessionId set', () => {
    const events: unknown[] = [
      { type: 'user', message: { content: [{ type: 'text', text: 'hello from transcript' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi back from assistant' }] }
      }
    ]
    const s = reduceChat(initialChatState(), {
      kind: 'loadTranscript',
      events,
      sessionId: 'sess-1'
    })
    expect(s.items).toHaveLength(2)
    expect(s.items[0]).toMatchObject({ role: 'user', text: 'hello from transcript' })
    expect(s.items[1]).toMatchObject({ role: 'assistant', text: 'hi back from assistant' })
    expect(s.sessionId).toBe('sess-1')
    expect(s.running).toBe(false)
  })

  it('checkpoint event appends a checkpoint item with sha', () => {
    const s = feed([
      {
        kind: 'event',
        event: {
          type: 'checkpoint',
          sha: 'abc123',
          createdAt: '2024-01-01T20:31:00.000Z',
          label: 'Before user turn'
        }
      }
    ])
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({
      role: 'checkpoint',
      sha: 'abc123',
      label: 'Before user turn'
    })
  })

  it('info action appends an info item', () => {
    const s = reduceChat(initialChatState(), {
      kind: 'info',
      text: 'Reverted files to checkpoint 20:31'
    })
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ role: 'info', text: 'Reverted files to checkpoint 20:31' })
  })

  it('accumulates text deltas from stream_event into stream.text', () => {
    const s = feed([
      {
        kind: 'event',
        event: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }
        }
      },
      {
        kind: 'event',
        event: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }
        }
      }
    ])
    expect(s.stream).toMatchObject({ text: 'Hello' })
  })

  it('accumulates thinking deltas separately from text', () => {
    const s = feed([
      {
        kind: 'event',
        event: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'hmm' }
          }
        }
      }
    ])
    expect(s.stream).toMatchObject({ text: '', thinking: 'hmm' })
  })

  it('clears stream when the complete assistant message arrives', () => {
    const s = feed([
      {
        kind: 'event',
        event: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }
        }
      },
      {
        kind: 'event',
        event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }
      }
    ])
    expect(s.stream).toBeNull()
    expect(s.items.at(-1)).toMatchObject({ role: 'assistant', text: 'Hi' })
  })

  it('appends a thinking item from assistant thinking blocks', () => {
    const s = feed([
      {
        kind: 'event',
        event: {
          type: 'assistant',
          message: { content: [{ type: 'thinking', thinking: 'reasoning…', signature: 'x' }] }
        }
      }
    ])
    expect(s.items.at(-1)).toMatchObject({ role: 'thinking', text: 'reasoning…' })
  })

  it('captures usage and accumulates cost across result events', () => {
    const result1 = {
      kind: 'event',
      event: {
        type: 'result',
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 500
        }
      }
    }
    const result2 = {
      kind: 'event',
      event: {
        type: 'result',
        total_cost_usd: 0.02,
        usage: { input_tokens: 20, output_tokens: 50, cache_read_input_tokens: 6000 }
      }
    }
    const s = feed([result1, result2])
    expect(s.usage).toEqual({
      // context = latest result only (input + cache read + cache creation)
      contextTokens: 6020,
      // output + cost accumulate across turns
      outputTokens: 150,
      costUsd: 0.07
    })
    expect(s.running).toBe(false)
    expect(s.stream).toBeNull()
  })

  it('surfaces result errors as a visible info item', () => {
    const s = feed([
      { kind: 'setRunning', running: true },
      {
        kind: 'event',
        event: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['No conversation found with session ID: x']
        }
      }
    ])
    expect(s.running).toBe(false)
    expect(s.items.at(-1)).toMatchObject({
      role: 'info',
      text: '⚠ No conversation found with session ID: x'
    })
  })

  it('loadTranscript: user message with string content is handled', () => {
    const events: unknown[] = [
      { type: 'user', message: { content: 'plain string user message' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response' }] }
      }
    ]
    const s = reduceChat(initialChatState(), {
      kind: 'loadTranscript',
      events,
      sessionId: 'sess-2'
    })
    expect(s.items).toHaveLength(2)
    expect(s.items[0]).toMatchObject({ role: 'user', text: 'plain string user message' })
    expect(s.sessionId).toBe('sess-2')
  })
})
