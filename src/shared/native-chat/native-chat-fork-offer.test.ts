import { describe, expect, it } from 'vitest'
import {
  nativeChatForkableItemIds,
  nativeChatForkSupport,
  nativeChatRowOffersFork
} from './native-chat-fork-offer'
import type { NativeChatMessage } from './native-chat-types'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../agent-session/view/structured-agent-session-projection'
import { foldToolMessages } from './tools/native-chat-tool-fold'
import { projectNativeChatTaskListFrames } from './input/native-chat-task-list-frames'

const reply: NativeChatMessage = {
  id: 'item-reply',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Done.' }],
  timestamp: 1,
  source: 'transcript',
  journalPosition: { sequence: 12, index: 0 }
}
const finished = { message: reply, inSubagentSection: false, turnWorking: false }
const forkableItemIds = new Set(['item-reply'])
const checkpoint = {
  support: { kind: 'known', fork: 'checkpoint' },
  contextFloorSequence: 0,
  forkableItemIds
} as const
const tip = {
  support: { kind: 'known', fork: 'tip' },
  contextFloorSequence: 0,
  forkableItemIds
} as const

describe('nativeChatRowOffersFork', () => {
  it('offers any finished root response of an agent that forks through any turn', () => {
    expect(nativeChatRowOffersFork({ ...finished, inLatestTurn: false }, checkpoint)).toBe(true)
  })

  it('offers only the newest turn of an agent that forks at its tip', () => {
    expect(nativeChatRowOffersFork({ ...finished, inLatestTurn: false }, tip)).toBe(false)
    expect(nativeChatRowOffersFork({ ...finished, inLatestTurn: true }, tip)).toBe(true)
  })

  it.each([
    ['a running turn', { ...finished, turnWorking: true }, checkpoint],
    ['a subagent section', { ...finished, inSubagentSection: true }, checkpoint],
    ['a subagent reply', { ...finished, message: { ...reply, agentId: 'child' } }, checkpoint],
    ['a row above a /clear', finished, { ...checkpoint, contextFloorSequence: 12 }],
    [
      'an agent without forks',
      finished,
      { support: { kind: 'none' }, contextFloorSequence: 0, forkableItemIds }
    ]
  ] as const)('hides it in %s', (_case, row, chat) => {
    expect(nativeChatRowOffersFork({ ...row, inLatestTurn: true }, chat)).toBe(false)
  })
})

describe('a displayed row forks only through the agent message it shows', () => {
  const item = (
    itemId: string,
    sequence: number,
    body: AgentJournalRenderItem['body']
  ): AgentJournalRenderItem => ({ itemId, sequence, revision: 1, observedAt: sequence, body })
  const items = [
    item('prose', 1, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Hi' }]
    }),
    item('read', 2, { kind: 'tool-call', name: 'Read', input: {}, state: 'completed' }),
    item('lone-tool', 3, { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }),
    item('plan', 4, {
      kind: 'status',
      text: 'Plan updated',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:turn/plan/updated',
        payload: {
          head: JSON.stringify({ plan: [{ step: 'Verify', status: 'completed' }] }),
          byteLength: 50,
          digest: 'synthetic',
          truncated: false
        }
      }
    })
  ]
  // The phone's display projection: tool rows fold into the prose before them; plans become tools.
  const rows = projectNativeChatTaskListFrames(
    foldToolMessages(projectStructuredItemsToNativeChat(items))
  )
  const offered = (id: string) => {
    const message = rows.find((row) => row.id === id)!
    return nativeChatRowOffersFork(
      { message, inSubagentSection: false, turnWorking: false, inLatestTurn: true },
      { ...checkpoint, forkableItemIds: nativeChatForkableItemIds(items) }
    )
  }

  it('offers a folded prose response, and no plan or tool row drawn as one', () => {
    expect(rows.find((row) => row.id === 'plan')?.role).toBe('assistant')
    expect(offered('prose')).toBe(true)
    expect(offered('plan')).toBe(false)
  })
})

describe('nativeChatForkSupport', () => {
  it('waits on an unanswered host or agent list, and hides once either says no', () => {
    const forks = { capabilities: { fork: 'checkpoint' as const } }
    expect(nativeChatForkSupport('unknown', forks)).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('supported', undefined)).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('unsupported', forks)).toEqual({ kind: 'none' })
    expect(nativeChatForkSupport('supported', { capabilities: {} })).toEqual({ kind: 'none' })
    expect(nativeChatForkSupport('supported', forks)).toEqual({
      kind: 'known',
      fork: 'checkpoint'
    })
  })
})
