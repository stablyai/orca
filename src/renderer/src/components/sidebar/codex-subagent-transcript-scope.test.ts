import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatRole } from '../../../../shared/native-chat-types'
import { scopeCodexSubagentTranscript } from './codex-subagent-transcript-scope'

function message(id: string, role: NativeChatRole, timestamp: number | null): NativeChatMessage {
  return {
    id,
    role,
    timestamp,
    source: 'transcript',
    blocks: [{ type: 'text', text: id }]
  }
}

describe('scopeCodexSubagentTranscript', () => {
  it('removes the parent prefix copied into a full-history child rollout', () => {
    const scoped = scopeCodexSubagentTranscript(
      [
        message('parent-user', 'user', 1_000),
        message('parent-assistant', 'assistant', 1_100),
        message('child-progress', 'assistant', 2_100),
        message('child-tool-result', 'tool', null)
      ],
      true,
      2_000
    )

    expect(scoped.messages.map((entry) => entry.id)).toEqual([
      'child-progress',
      'child-tool-result'
    ])
    expect(scoped.hasMore).toBe(false)
  })

  it('keeps older-history pagination until the child start boundary is reached', () => {
    expect(
      scopeCodexSubagentTranscript([message('child-later', 'assistant', 2_200)], true, 2_000)
        .hasMore
    ).toBe(true)
    expect(
      scopeCodexSubagentTranscript(
        [message('parent', 'user', 1_900), message('child-first', 'assistant', 2_100)],
        true,
        2_000
      ).hasMore
    ).toBe(false)
  })

  it('does not expose transcript messages without a trusted child boundary', () => {
    expect(scopeCodexSubagentTranscript([message('parent', 'user', 1_000)], true, 0)).toEqual({
      messages: [],
      hasMore: false
    })
  })
})
