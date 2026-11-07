import { describe, expect, it } from 'vitest'
import { nativeChatSideChatForkPoint } from './native-chat-side-chat-fork-point'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'

function slot(
  id: string,
  role: 'user' | 'assistant',
  turnKey: string,
  activeTurnIsWorking = false,
  depth = 0
): NativeChatMessageSlot {
  return {
    kind: 'message',
    message: {
      id,
      role,
      blocks: [{ type: 'text', text: id }],
      timestamp: 1,
      source: 'transcript',
      journalPosition: { sequence: id.endsWith('1') ? 11 : 21, index: 0 }
    },
    turnKey,
    activeTurnIsWorking,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    subagentRoster: undefined,
    depth,
    estimatedHeight: 40
  }
}

const chat = (fork: 'checkpoint' | 'tip') =>
  ({
    support: { kind: 'known', fork },
    contextFloorSequence: 0,
    forkableItemIds: new Set(['reply-1', 'reply-2'])
  }) as const

const transcript = (working: boolean) => [
  slot('ask-1', 'user', 'turn-1'),
  slot('reply-1', 'assistant', 'turn-1'),
  slot('ask-2', 'user', 'turn-2', working),
  slot('reply-2', 'assistant', 'turn-2', working)
]

describe('nativeChatSideChatForkPoint', () => {
  it('forks a running chat through its last finished response', () => {
    expect(
      nativeChatSideChatForkPoint(transcript(true), 'turn-2', true, chat('checkpoint'))
    ).toEqual({ kind: 'ready', throughItemId: 'reply-1' })
  })

  it('waits for the running reply where the agent forks only at its tip', () => {
    expect(nativeChatSideChatForkPoint(transcript(true), 'turn-2', true, chat('tip'))).toEqual({
      kind: 'reply-running'
    })
    expect(nativeChatSideChatForkPoint(transcript(false), 'turn-2', false, chat('tip'))).toEqual({
      kind: 'ready',
      throughItemId: 'reply-2'
    })
  })

  it('has nothing to fork before the first reply', () => {
    expect(
      nativeChatSideChatForkPoint(
        [slot('ask-1', 'user', 'turn-1')],
        'turn-1',
        false,
        chat('checkpoint')
      )
    ).toEqual({ kind: 'no-reply' })
  })

  it('looks past an older subagent section drawn below the newest reply', () => {
    expect(
      nativeChatSideChatForkPoint(
        [...transcript(false), slot('child-1', 'assistant', 'turn-1', false, 1)],
        'turn-2',
        false,
        chat('tip')
      )
    ).toEqual({ kind: 'ready', throughItemId: 'reply-2' })
  })
})
