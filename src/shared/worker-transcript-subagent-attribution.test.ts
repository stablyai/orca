import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { formatWorkerTranscriptMessages } from './worker-transcript-text'

function message(
  id: string,
  text: string,
  overrides: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

const roster = message('roster', 'Kicked off 1 subagent', {
  role: 'system',
  blocks: [
    { type: 'text', text: 'Kicked off 1 subagent' },
    {
      type: 'subagent-group',
      groupId: 'group-1',
      agents: [{ id: 'task-1', label: 'review the PR', state: 'working' }]
    }
  ]
})

describe("a worker's transcript never gives a subagent's words to the worker", () => {
  it("tags a subagent's line with the subagent the roster names", () => {
    const [own, , child] = formatWorkerTranscriptMessages([
      message('own', 'Delegating the review.'),
      roster,
      message('child', 'The PR is CLEAN.', { agentId: 'task-1' })
    ])
    expect(own).toBe('[assistant] Delegating the review.')
    expect(child).toBe('[assistant, subagent review the PR] The PR is CLEAN.')
  })

  it('still tags a subagent that no roster on the page names', () => {
    const [child] = formatWorkerTranscriptMessages([
      message('child', 'Still looking.', { agentId: 'task-9' })
    ])
    expect(child).toBe('[assistant, subagent] Still looking.')
  })
})
