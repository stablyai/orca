import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectSubagentTranscript } from './subagent-transcript-projection'

const message = (overrides: Partial<NativeChatMessage>): NativeChatMessage => ({
  id: 'message',
  role: 'system',
  blocks: [],
  timestamp: 1,
  source: 'transcript',
  ...overrides
})

describe('projectSubagentTranscript', () => {
  it('removes bootstrap and renders the parent task before real subagent activity', () => {
    const result = projectSubagentTranscript(
      [
        message({
          id: 'bootstrap',
          role: 'user',
          blocks: [{ type: 'text', text: 'AGENTS.md and system bootstrap' }]
        }),
        message({
          id: 'boundary',
          subagentEvent: { kind: 'turn-boundary', triggerTurn: true }
        }),
        message({
          id: 'task',
          subagentEvent: {
            kind: 'agent-message',
            author: '/root',
            recipient: '/root/worker'
          }
        }),
        message({
          id: 'reasoning',
          role: 'reasoning',
          blocks: [{ type: 'text', text: 'Checking' }]
        }),
        message({
          id: 'answer',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Done' }]
        })
      ],
      'codex'
    )

    expect(result.map((entry) => entry.id)).toEqual(['task', 'reasoning', 'answer'])
    expect(result[0]).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'Task from @codex' }],
      subagentEvent: { kind: 'task', parentIdentity: 'codex' }
    })
  })
})
