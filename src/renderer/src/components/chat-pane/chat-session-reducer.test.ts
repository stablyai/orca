import { describe, expect, it } from 'vitest'
import { reduceJcodeEvent } from './chat-session-reducer'
import type { ChatSessionState } from './chat-session-types'

function streamingState(): ChatSessionState {
  return {
    messages: [
      { id: 'user-1', role: 'user', text: 'Run tests' },
      { id: 'assistant-1', role: 'assistant', text: '' }
    ],
    isStreaming: true,
    statusDetail: 'Thinking...',
    resumeSessionId: undefined,
    streamingId: 'assistant-1',
    composerProvider: undefined,
    composerModel: undefined,
    composerProviderProfile: undefined,
    pendingAttachments: []
  }
}

describe('reduceJcodeEvent', () => {
  it('accumulates streamed assistant text and finalizes on done', () => {
    const withStart = reduceJcodeEvent(streamingState(), {
      type: 'start',
      session_id: 'session-a'
    })
    const withText = reduceJcodeEvent(withStart, { type: 'text_delta', text: 'hello' })
    const done = reduceJcodeEvent(withText, {
      type: 'done',
      session_id: 'session-b',
      text: 'ignored final text'
    })

    expect(done.resumeSessionId).toBe('session-b')
    expect(done.messages.at(-1)?.text).toBe('hello')
    expect(done.isStreaming).toBe(false)
    expect(done.statusDetail).toBeNull()
    expect(done.streamingId).toBeNull()
  })

  it('upserts tool events on the streaming assistant message', () => {
    const withTool = [
      { type: 'tool_start', id: 'tool-1', name: 'bash' },
      { type: 'tool_input', id: 'tool-1', delta: '{"command":' },
      { type: 'tool_input', id: 'tool-1', delta: '"pnpm test"}' },
      { type: 'tool_done', id: 'tool-1', output: 'ok' }
    ].reduce(reduceJcodeEvent, streamingState())

    expect(withTool.messages.at(-1)?.tools).toEqual([
      {
        id: 'tool-1',
        name: 'bash',
        rawInput: '{"command":"pnpm test"}',
        output: 'ok',
        error: undefined,
        status: 'done'
      }
    ])
  })

  it('finalizes error and stopped events with transcript text', () => {
    const error = reduceJcodeEvent(streamingState(), {
      type: 'error',
      message: 'failed'
    })
    const stopped = reduceJcodeEvent(
      {
        ...streamingState(),
        messages: [{ id: 'assistant-1', role: 'assistant', text: 'partial' }]
      },
      { type: 'stopped' }
    )

    expect(error.messages.at(-1)).toMatchObject({ text: 'failed', isError: true })
    expect(error.isStreaming).toBe(false)
    expect(stopped.messages.at(-1)?.text).toBe('partial\n\n(stopped)')
    expect(stopped.streamingId).toBeNull()
  })
})
