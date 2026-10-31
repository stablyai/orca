import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { stripNoiseMessages } from '../../../../shared/native-chat-noise'
import { projectNativeChatTranscriptMessages } from '../../../../shared/native-chat-transcript-projection'
import { nativeChatChildTranscript } from './native-chat-child-transcript'

function message(id: string, agentId?: string, parentAgentId?: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript',
    ...(agentId === undefined ? {} : { agentId }),
    ...(parentAgentId === undefined ? {} : { parentAgentId })
  }
}

describe('a child conversation', () => {
  it('shows its own rows as a full conversation while retaining nested attribution', () => {
    const parent = message('parent')
    const child = message('child-output', 'child')
    const nested = message('nested-output', 'nested', 'child')
    const sibling = message('sibling-output', 'sibling')
    const rows = nativeChatChildTranscript([parent, child, nested, sibling], 'child')
    expect(rows.map((row) => row.id)).toEqual(['child-output', 'nested-output'])
    expect(rows[0]?.agentId).toBeUndefined()
    expect(rows[1]).toBe(nested)
    expect(child.agentId).toBe('child')
  })

  it('recovers exact recorded parent assignments in older journals and yields to native child input', () => {
    const prompt =
      '<system-reminder>Read the complete task</system-reminder>\nDo not omit this original instruction.'
    const assignment: NativeChatMessage = {
      ...message('parent-spawn'),
      blocks: [
        {
          type: 'tool-call',
          name: 'spawn_agent',
          callId: 'spawn-call',
          state: 'completed',
          input: { agents: ['child'], prompt }
        }
      ]
    }
    const response = message('child-response', 'child')
    const rows = nativeChatChildTranscript([assignment, response], 'child')
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
    expect(rows[0]?.blocks).toEqual([{ type: 'text', text: prompt }])
    expect(projectNativeChatTranscriptMessages(rows)).toHaveLength(2)
    expect(rows[0]?.from).toEqual({ kind: 'agent', senders: [], orchestration: null })
    expect(nativeChatChildTranscript([assignment, response], 'child')[0]?.id).toBe(rows[0]?.id)
    expect(nativeChatChildTranscript([assignment, response], 'unrelated')).toEqual([])

    const notice: NativeChatMessage = {
      ...message('mail-pointer'),
      role: 'user',
      blocks: [{ type: 'text', text: '<system-reminder>Mail pointer</system-reminder>' }],
      from: {
        kind: 'agent',
        senders: [],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'terminal',
          dispatchId: null,
          messages: []
        }
      }
    }
    expect(stripNoiseMessages([notice])).toEqual([])
    const native: NativeChatMessage = {
      ...message('native-input', 'child'),
      role: 'user',
      blocks: [{ type: 'text', text: prompt }]
    }
    const updated = nativeChatChildTranscript([assignment, native, response], 'child')
    expect(updated.map((row) => row.id)).toEqual(['native-input', 'child-response'])
    expect(projectNativeChatTranscriptMessages(updated)).toHaveLength(2)
  })

  it.each(['Task', 'Agent'])(
    'recovers a Claude %s assignment only through its exact recorded parent-call binding',
    (name) => {
      const prompt = 'Complete original Claude assignment.\nKeep every instruction.'
      const assignment: NativeChatMessage = {
        ...message('claude-spawn'),
        blocks: [
          {
            type: 'tool-call',
            name,
            callId: 'toolu_spawn',
            state: 'running',
            input: { description: 'A short label', prompt }
          }
        ]
      }
      const child: NativeChatMessage = {
        ...message('claude-answer', 'canonical-task'),
        providerParentRef: 'toolu_spawn'
      }
      const rows = nativeChatChildTranscript([assignment, child], 'canonical-task')
      expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
      expect(rows[0]?.blocks).toEqual([{ type: 'text', text: prompt }])
      expect(
        nativeChatChildTranscript(
          [assignment, { ...child, providerParentRef: 'another-call' }],
          'canonical-task'
        ).map((row) => row.id)
      ).toEqual(['claude-answer'])
      const native: NativeChatMessage = {
        ...child,
        id: 'claude-input',
        role: 'user',
        blocks: [{ type: 'text', text: prompt }]
      }
      expect(
        nativeChatChildTranscript([assignment, native, child], 'canonical-task').map(
          (row) => row.id
        )
      ).toEqual(['claude-input', 'claude-answer'])
      expect(
        nativeChatChildTranscript(
          [assignment, child, { ...child, id: 'ambiguous', agentId: 'different-child' }],
          'canonical-task'
        ).map((row) => row.id)
      ).toEqual(['claude-answer'])
    }
  )

  it('finds grandchildren regardless of page order and terminates on broken ownership cycles', () => {
    const rows = [
      message('grandchild', 'grandchild', 'nested'),
      message('nested', 'nested', 'child'),
      message('child', 'child', 'nested'),
      message('unrelated', 'other', 'other')
    ]
    expect(nativeChatChildTranscript(rows, 'child').map((row) => row.id)).toEqual([
      'grandchild',
      'nested',
      'child'
    ])
    expect(nativeChatChildTranscript(rows, 'missing')).toEqual([])
  })

  it('opens a legacy Codex background-task id at its bare thread journal without sibling rows', () => {
    const rows = nativeChatChildTranscript(
      [message('parent'), message('child', 'thread-a'), message('sibling', 'thread-b')],
      'codex-agent:thread-a'
    )
    expect(rows.map((row) => row.id)).toEqual(['child'])
    expect(rows[0]?.agentId).toBeUndefined()
  })
})
