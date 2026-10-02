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
  it.each([true, false])('projects parent tasks with showIdentity=%s', (showIdentity) => {
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
      'codex',
      showIdentity
    )

    expect(result.map((entry) => entry.id)).toEqual(['task', 'reasoning', 'answer'])
    expect(result[0]).toMatchObject({
      role: 'user',
      blocks: [
        { type: 'text', text: showIdentity ? 'Task from @codex' : 'Task from parent agent' }
      ],
      subagentEvent: { kind: 'task', parentIdentity: 'codex' }
    })
  })
})
