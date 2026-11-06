import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import {
  frameNativeChatSubagentTranscript,
  nativeChatSpawnedSubagentId
} from './native-chat-subagent-brief'

function text(message: NativeChatMessage): string {
  return message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function user(id: string, body: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: body }],
    timestamp: null,
    source: 'transcript'
  }
}

function assistant(id: string, body: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: body }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('native chat subagent brief', () => {
  it('reads a Claude description and prompt, and ignores the launch ack', () => {
    const parent: NativeChatMessage = {
      id: 'spawn',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'Agent',
          input: { description: 'Fix CodeRabbit on #36729', prompt: 'Address the review comment' }
        },
        {
          type: 'tool-result',
          output: 'Async agent launched successfully.\nagentId: a41bd1a2fa1e0bf60'
        }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const framed = frameNativeChatSubagentTranscript(
      'a41bd1a2fa1e0bf60',
      [
        user('child-user', 'Address the review comment'),
        assistant('child-end', 'Fixed and pushed')
      ],
      [parent]
    )
    expect(text(framed[0]!)).toBe('Fix CodeRabbit on #36729')
    expect(text(framed[1]!)).toBe('Address the review comment')
    expect(text(framed.at(-1)!)).toBe('Fixed and pushed')
    expect(framed.some((message) => message.id.endsWith(':result'))).toBe(false)
  })

  it('uses a Codex task name and drops the encrypted spawn row', () => {
    const parent: NativeChatMessage = {
      id: 'spawn',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'spawn_agent',
          input: { task_name: 'sample_greeting', message: 'gAAAAAencrypted' }
        },
        { type: 'tool-result', output: '{"task_name":"/root/sample_greeting"}' }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const echoed: NativeChatMessage = {
      id: 'echo',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'spawn_agent', input: { message: 'gAAAAAencrypted' } }],
      timestamp: null,
      source: 'transcript'
    }
    const framed = frameNativeChatSubagentTranscript(
      '/root/sample_greeting',
      [echoed, assistant('hello', 'Hello from Orca')],
      [parent]
    )
    expect(framed.map((message) => text(message))).toEqual(['sample_greeting', 'Hello from Orca'])
    expect(
      nativeChatSpawnedSubagentId('spawn_agent', {
        output: '{"task_name":"/root/sample_greeting"}'
      })
    ).toBe('/root/sample_greeting')
    expect(nativeChatSpawnedSubagentId('Bash', undefined)).toBeNull()
  })

  it('keeps a Grok background spawn ack off the child result', () => {
    const childId = '01a19910-dddd-7ddd-8ddd-dddddddddddd'
    const parent: NativeChatMessage = {
      id: 'spawn',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'spawn_subagent',
          callId: 'call-1',
          input: { description: 'Say hello', prompt: 'Reply with exactly: Hello from Grok' }
        },
        {
          type: 'tool-result',
          callId: 'call-1',
          output: `Subagent started in background.\nsubagent_id: ${childId}\ndescription: Say hello\n\nWhen you need its result, use get_command_or_subagent_output.`
        }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const framed = frameNativeChatSubagentTranscript(
      childId,
      [
        user('child-user', 'Reply with exactly: Hello from Grok'),
        assistant('child-end', 'Hello from Grok')
      ],
      [parent]
    )
    expect(text(framed[0]!)).toBe('Say hello')
    expect(text(framed[1]!)).toBe('Reply with exactly: Hello from Grok')
    expect(text(framed.at(-1)!)).toBe('Hello from Grok')
    expect(framed.some((message) => text(message).includes('Subagent started'))).toBe(false)
  })

  it('drops the Grok subagent_result trailer from a foreground reply', () => {
    const childId = '01a19984-7518-7790-b750-a335273057b8'
    const parent: NativeChatMessage = {
      id: 'spawn',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'spawn_subagent',
          callId: 'call-1',
          input: {
            description: 'Say hello',
            prompt:
              'Reply with exactly this sentence and nothing else: Hello from the Grok scratch subagent.'
          }
        },
        {
          type: 'tool-result',
          callId: 'call-1',
          output: `Hello from the Grok scratch subagent.\n\n<subagent_result>\nsubagent_id: ${childId}\n</subagent_result>`
        }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const framed = frameNativeChatSubagentTranscript(
      childId,
      [
        user(
          'child-user',
          'Reply with exactly this sentence and nothing else: Hello from the Grok scratch subagent.'
        ),
        assistant('child-end', 'Hello from the Grok scratch subagent.')
      ],
      [parent]
    )
    expect(text(framed[0]!)).toBe('Say hello')
    expect(text(framed.at(-1)!)).toBe('Hello from the Grok scratch subagent.')
    expect(framed.some((message) => text(message).includes('subagent_id'))).toBe(false)
    expect(
      framed.filter((message) => text(message) === 'Hello from the Grok scratch subagent.')
    ).toHaveLength(1)
  })
})
