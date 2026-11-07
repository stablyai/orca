import { describe, expect, it } from 'vitest'
import {
  nativeChatForkableItemIds,
  nativeChatForkSupport,
  nativeChatLatestForkPoint,
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
  const forks = { capabilities: { fork: 'checkpoint' as const } }
  const tipForks = { capabilities: { fork: 'tip' as const } }

  it('waits on an unanswered host or agent list, and hides once either says no', () => {
    expect(nativeChatForkSupport('unknown', forks, 'supported')).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('supported', undefined, 'supported')).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('unsupported', forks, 'supported')).toEqual({ kind: 'none' })
    expect(nativeChatForkSupport('supported', { capabilities: {} }, 'supported')).toEqual({
      kind: 'none'
    })
  })

  it('follows the chat options verdict on its installed agent', () => {
    expect(nativeChatForkSupport('supported', tipForks, 'unsupported')).toEqual({ kind: 'none' })
    expect(nativeChatForkSupport('supported', tipForks, 'unknown')).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('supported', tipForks, undefined)).toEqual({ kind: 'unknown' })
    expect(nativeChatForkSupport('supported', tipForks, 'supported')).toEqual({
      kind: 'known',
      fork: 'tip'
    })
  })
})

describe('nativeChatLatestForkPoint', () => {
  const row = (id: string, role: 'user' | 'assistant', sequence: number): NativeChatMessage => ({
    id,
    role,
    blocks: [{ type: 'text', text: id }],
    timestamp: sequence,
    source: 'transcript',
    journalPosition: { sequence, index: 0 }
  })
  const running = [
    row('ask-1', 'user', 10),
    row('reply-1', 'assistant', 11),
    row('ask-2', 'user', 20),
    row('reply-2', 'assistant', 21)
  ]
  const chat = (fork: 'checkpoint' | 'tip') =>
    ({
      support: { kind: 'known', fork },
      contextFloorSequence: 0,
      forkableItemIds: new Set(['reply-1', 'reply-2'])
    }) as const

  it('forks a running chat through its last finished response', () => {
    expect(
      nativeChatLatestForkPoint(
        { messages: running, journal: null, agentWorking: true },
        chat('checkpoint')
      )
    ).toEqual({ kind: 'ready', throughItemId: 'reply-1' })
  })

  it('waits for the running reply where the agent forks only at its tip', () => {
    expect(
      nativeChatLatestForkPoint(
        { messages: running, journal: null, agentWorking: true },
        chat('tip')
      )
    ).toEqual({ kind: 'reply-running' })
    expect(
      nativeChatLatestForkPoint(
        { messages: running, journal: null, agentWorking: false },
        chat('tip')
      )
    ).toEqual({ kind: 'ready', throughItemId: 'reply-2' })
  })

  it('has nothing to fork before the first reply', () => {
    expect(
      nativeChatLatestForkPoint(
        { messages: [row('ask-1', 'user', 10)], journal: null, agentWorking: false },
        chat('checkpoint')
      )
    ).toEqual({ kind: 'no-reply' })
  })
})
