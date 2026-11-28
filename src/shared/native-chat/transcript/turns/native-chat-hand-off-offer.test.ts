import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import {
  nativeChatRowOffersHandOff,
  sliceNativeChatMessagesThrough
} from './native-chat-hand-off-offer'
import { buildAgentSessionHandoffContext } from '../agent-session-handoff-context'
import { buildAgentSessionContinuationPrompt } from '../../../agent-session/conversation-context/agent-session-continuation'

function textMessage(
  id: string,
  role: 'user' | 'assistant' | 'system',
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    source: 'transcript',
    timestamp: 1_700_000_000_000,
    blocks: [{ type: 'text', text }],
    ...extra
  }
}

describe('nativeChatRowOffersHandOff', () => {
  it('offers hand-off on finished root assistant transcript responses within context', () => {
    const reply = textMessage('a1', 'assistant', 'Good answer', {
      journalPosition: { sequence: 5, index: 0 }
    })
    expect(
      nativeChatRowOffersHandOff(
        { message: reply, inSubagentSection: false, turnWorking: false },
        { contextFloorSequence: 2 }
      )
    ).toBe(true)
  })

  it('rejects non-assistant, working, subagent, agentStart, and pre-clear rows', () => {
    const base = textMessage('a1', 'assistant', 'Answer', {
      journalPosition: { sequence: 5, index: 0 }
    })
    expect(
      nativeChatRowOffersHandOff(
        {
          message: textMessage('u1', 'user', 'Prompt'),
          inSubagentSection: false,
          turnWorking: false
        },
        { contextFloorSequence: 0 }
      )
    ).toBe(false)
    expect(
      nativeChatRowOffersHandOff(
        { message: base, inSubagentSection: false, turnWorking: true },
        { contextFloorSequence: 0 }
      )
    ).toBe(false)
    expect(
      nativeChatRowOffersHandOff(
        { message: base, inSubagentSection: true, turnWorking: false },
        { contextFloorSequence: 0 }
      )
    ).toBe(false)
    expect(
      nativeChatRowOffersHandOff(
        { message: { ...base, agentStart: true }, inSubagentSection: false, turnWorking: false },
        { contextFloorSequence: 0 }
      )
    ).toBe(false)
    expect(
      nativeChatRowOffersHandOff(
        {
          message: { ...base, agentId: 'subagent-1' },
          inSubagentSection: false,
          turnWorking: false
        },
        { contextFloorSequence: 0 }
      )
    ).toBe(false)
    expect(
      nativeChatRowOffersHandOff(
        { message: base, inSubagentSection: false, turnWorking: false },
        { contextFloorSequence: 5 }
      )
    ).toBe(false)
    expect(
      nativeChatRowOffersHandOff(
        {
          message: { ...base, journalPosition: undefined },
          inSubagentSection: false,
          turnWorking: false
        },
        { contextFloorSequence: 3 }
      )
    ).toBe(false)
  })
})

describe('sliceNativeChatMessagesThrough', () => {
  it('cuts off later turns, respects contextFloorSequence, and strips queued/unsent drafts', () => {
    const messages: NativeChatMessage[] = [
      textMessage('old-u', 'user', 'Before clear', { journalPosition: { sequence: 1, index: 0 } }),
      textMessage('old-a', 'assistant', 'Old reply', {
        journalPosition: { sequence: 2, index: 0 }
      }),
      textMessage('u1', 'user', 'Turn 1 prompt', { journalPosition: { sequence: 4, index: 0 } }),
      textMessage('a1', 'assistant', 'Turn 1 good answer', {
        journalPosition: { sequence: 5, index: 0 }
      }),
      textMessage('draft', 'user', 'Queued follow-up', {
        queued: true,
        journalPosition: { sequence: 6, index: 0 }
      }),
      textMessage('u2', 'user', 'Turn 2 derailed', {
        journalPosition: { sequence: 7, index: 0 }
      }),
      textMessage('a2', 'assistant', 'Turn 2 bad answer', {
        journalPosition: { sequence: 8, index: 0 }
      })
    ]

    const sliced = sliceNativeChatMessagesThrough(messages, 'a1', 3)
    expect(sliced?.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(sliceNativeChatMessagesThrough(messages, 'missing-id', 0)).toBeNull()

    const capturedText = buildAgentSessionHandoffContext(sliced ?? [])
    const prompt = buildAgentSessionContinuationPrompt(
      {
        sourceKind: 'chat',
        sourceAgent: 'antigravity',
        sourceTitle: 'Refactor API',
        capturedText,
        transcriptPath: undefined,
        truncatedToResponse: true
      },
      'focused'
    )
    expect(prompt).not.toBeNull()
    expect(prompt).toContain('Continue work from an earlier point in a prior Orca session')
    expect(prompt).toContain('Only messages up to the selected response are included')
    expect(prompt).toContain('Turn 1 good answer')
    expect(prompt).not.toContain('Before clear')
    expect(prompt).not.toContain('Turn 2 derailed')
    expect(prompt).not.toContain('Turn 2 bad answer')
  })
})
