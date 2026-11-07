import { describe, expect, it, vi } from 'vitest'
import type * as ForkOffer from '../../../../shared/native-chat/native-chat-fork-offer'
import { nativeChatSideChatForkPoint } from './native-chat-side-chat-fork-point'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'

const offers = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../../shared/native-chat/native-chat-fork-offer', async (importOriginal) => {
  const actual = await importOriginal<typeof ForkOffer>()
  return {
    ...actual,
    nativeChatRowOffersFork: (...args: Parameters<typeof actual.nativeChatRowOffersFork>) => {
      offers.calls++
      return actual.nativeChatRowOffersFork(...args)
    }
  }
})

function reply(
  id: string,
  sequence: number,
  turnKey: string,
  working = false
): NativeChatMessageSlot {
  return {
    kind: 'message',
    message: {
      id,
      role: 'assistant',
      blocks: [{ type: 'text', text: id }],
      timestamp: sequence,
      source: 'transcript',
      journalPosition: { sequence, index: 0 }
    },
    turnKey,
    activeTurnIsWorking: working,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    subagentRoster: undefined,
    depth: 0,
    estimatedHeight: 40
  }
}

const chat = (fork: 'checkpoint' | 'tip', floor = 0) =>
  ({
    support: { kind: 'known', fork },
    contextFloorSequence: floor,
    forkableItemIds: new Set(['reply-1', 'reply-2'])
  }) as const

const responses = (working: boolean) => [
  [reply('reply-1', 11, 'turn-1')],
  [reply('reply-2', 21, 'turn-2', working)]
]

describe('nativeChatSideChatForkPoint', () => {
  it('forks a running chat through its last finished response', () => {
    expect(
      nativeChatSideChatForkPoint(responses(true), 'turn-2', true, chat('checkpoint'))
    ).toEqual({ kind: 'ready', throughItemId: 'reply-1' })
  })

  it('waits for the running reply where the agent forks only at its tip', () => {
    expect(nativeChatSideChatForkPoint(responses(true), 'turn-2', true, chat('tip'))).toEqual({
      kind: 'reply-running'
    })
    expect(nativeChatSideChatForkPoint(responses(false), 'turn-2', false, chat('tip'))).toEqual({
      kind: 'ready',
      throughItemId: 'reply-2'
    })
  })

  it('has nothing to fork before the first reply or above a /clear', () => {
    expect(nativeChatSideChatForkPoint([], 'turn-1', false, chat('checkpoint'))).toEqual({
      kind: 'no-reply'
    })
    expect(
      nativeChatSideChatForkPoint(responses(false), 'turn-2', false, chat('checkpoint', 30))
    ).toEqual({ kind: 'no-reply' })
  })

  it.each([100, 1000])('steps over a running turn of %i responses at once', (size) => {
    const running = Array.from({ length: size }, (_, index) =>
      reply(`live-${index}`, 100 + index, 'turn-3', true)
    )
    offers.calls = 0

    const point = nativeChatSideChatForkPoint(
      [...responses(false), running],
      'turn-3',
      true,
      chat('checkpoint')
    )

    expect(point).toEqual({ kind: 'ready', throughItemId: 'reply-2' })
    expect(offers.calls).toBe(1)
  })
})
