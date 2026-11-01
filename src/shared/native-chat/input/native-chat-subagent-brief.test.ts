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

  it('pins the task when the child page is only the tail, and appends a real parent result', () => {
    const parent: NativeChatMessage = {
      id: 'spawn',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'Task',
          input: { description: 'Count lines', prompt: 'Count the lines in README.md' }
        },
        {
          type: 'tool-result',
          output: 'README.md has 12 lines.',
          subagent: { id: 'child-1', state: 'completed' }
        }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const framed = frameNativeChatSubagentTranscript(
      'child-1',
      [assistant('mid', 'Reading the file')],
      [parent]
    )
    expect(framed.map((message) => text(message))).toEqual([
      'Count lines\n\nCount the lines in README.md',
      'Reading the file',
      'README.md has 12 lines.'
    ])
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

  it('holds the parent result back while the child page is still loading', () => {
    const parent: NativeChatMessage = {
      id: 'spawn',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Agent', input: { description: 'Greet', prompt: 'Say hello' } },
        {
          type: 'tool-result',
          output: 'Hello from the parent result.',
          subagent: { id: 'child', state: 'completed' }
        }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const framed = frameNativeChatSubagentTranscript('child', [], [parent], undefined, false)
    expect(framed.map((message) => text(message))).toEqual(['Greet\n\nSay hello'])
  })

  it('shows the hand-back report once, without the harness frame', () => {
    const report = 'Hello from the scratch subagent.'
    const parent: NativeChatMessage = {
      id: 'spawn',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'Agent',
          input: { description: 'Say hello', prompt: report }
        },
        {
          type: 'tool-result',
          output: `[Subagent hand-back] The report follows:\n  ${report}\nagentId: child-1\n<usage>subagent_tokens: 1\n</usage>`,
          subagent: { id: 'child-1', state: 'completed' }
        }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const already = frameNativeChatSubagentTranscript(
      'child-1',
      [user('child-user', report), assistant('child-end', report)],
      [parent]
    )
    expect(text(already[0]!)).toBe('Say hello')
    expect(text(already.at(-1)!)).toBe(report)
    expect(already.some((message) => message.id.endsWith(':result'))).toBe(false)

    const tail = frameNativeChatSubagentTranscript(
      'child-1',
      [assistant('mid', 'Reading the file')],
      [parent]
    )
    expect(text(tail[0]!)).toBe(`Say hello\n\n${report}`)
    expect(text(tail.at(-1)!)).toBe(report)
    expect(tail.at(-1)?.id).toBe('child-1:result')
    expect(text(tail.at(-1)!)).not.toContain('Subagent hand-back')
  })

  it('keeps a sealed spawn to the task name when the roster line is the result', () => {
    const framed = frameNativeChatSubagentTranscript(
      '01a19905-3734-7941-9a1b-e256ccbdb54d',
      [
        user(
          'echo',
          'Call spawn_agent exactly once.\ntask_name: sample_greeting\nmessage: Reply with exactly this sentence and nothing else: Hello from Orca scratch.'
        ),
        assistant('end', 'Hello from Orca scratch.')
      ],
      [],
      { title: 'sample_greeting', prompt: 'Hello from Orca scratch.' }
    )
    expect(text(framed[0]!)).toBe('sample_greeting')
    expect(text(framed[1]!)).toContain('Call spawn_agent exactly once.')
    expect(text(framed.at(-1)!)).toBe('Hello from Orca scratch.')
    expect(framed.filter((message) => text(message) === 'Hello from Orca scratch.')).toHaveLength(1)
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
})
