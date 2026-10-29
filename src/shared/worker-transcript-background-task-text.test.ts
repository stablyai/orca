import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { formatWorkerTranscriptMessage } from './worker-transcript-text'

function message(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'm-1', role: 'system', blocks, timestamp: null, source: 'hook' }
}

describe('worker transcript text — background task rows', () => {
  it('prints the twin once and never the raw block', () => {
    const text = formatWorkerTranscriptMessage(
      message([
        { type: 'text', text: 'Background command "X" failed with exit code 1' },
        {
          type: 'background-task',
          taskId: 'task-1',
          kind: 'command',
          label: 'X',
          state: 'blocked',
          summary: 'Background command "X" failed with exit code 1'
        }
      ])
    )
    expect(text).toBe('[system] Background command "X" failed with exit code 1')
    expect(text).not.toContain('[unsupported block]')
  })

  it('prints a row that arrived with no twin rather than dropping its sentence', () => {
    expect(
      formatWorkerTranscriptMessage(
        message([
          {
            type: 'background-task',
            taskId: 'task-1',
            kind: 'command',
            label: 'X',
            state: 'blocked',
            summary: 'it failed'
          }
        ])
      )
    ).toBe('[system] it failed')
  })
})
