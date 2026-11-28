import { expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../agent-session/journal/agent-session-journal-types'
import { botGroupCompletedReply } from './bot-group-completed-reply'

function row(itemId: string, sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    body,
    sequence,
    observedAt: 1_000 + sequence,
    turnScope: { kind: 'turn', turnItemId: 'turn' }
  }
}

function savedReply(...steps: string[]): string | undefined {
  const items = [
    row('turn', 0, {
      kind: 'turn',
      turnId: 'provider-turn',
      state: 'completed',
      userItemId: 'post',
      startedAt: 1_000,
      outcome: 'success',
      completedAt: 3_000
    }),
    row('post', 1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Post' }] }),
    ...steps.map((step, index) =>
      step === 'tool'
        ? row(`tool-${index}`, index + 2, {
            kind: 'tool-call',
            name: 'Bash',
            input: { command: 'ls' },
            callId: `call-${index}`,
            state: 'completed'
          })
        : step === 'failure'
          ? row(`failure-${index}`, index + 2, { kind: 'status', text: 'API error', tone: 'error' })
          : row(`words-${index}`, index + 2, {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: step }]
            })
    )
  ]
  return botGroupCompletedReply(items)?.full
}

it('saves only the answer the settled room turn draws, never narration before tool calls', () => {
  expect(
    savedReply('Now the README. I will ask @Quill to review it after.', 'tool', 'Done, @Quill.')
  ).toBe('Done, @Quill.')
  expect(savedReply('Checking.', 'tool', 'Still checking.', 'tool', 'Done.')).toBe('Done.')
  expect(savedReply('First.', 'Second.')).toBe('First.\nSecond.')
  expect(savedReply('Looking into it.', 'tool')).toBe('Looking into it.')
  // The room ends such a turn on its failure row, which is no member's reply.
  expect(savedReply('Looking into it.', 'tool', 'failure')).toBeUndefined()
})
