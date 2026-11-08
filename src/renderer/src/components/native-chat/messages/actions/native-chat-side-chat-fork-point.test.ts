import { describe, expect, it, vi } from 'vitest'
import type * as ForkOffer from '../../../../../../shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlotsInput } from '../../conversation/slots/native-chat-transcript-input'
import { buildNativeChatTranscript } from '../../conversation/slots/native-chat-transcript-slots'

const offers = vi.hoisted(() => ({ checks: 0 }))
vi.mock('../../../../../../shared/native-chat/native-chat-fork-offer', async (importOriginal) => {
  const actual = await importOriginal<typeof ForkOffer>()
  return {
    ...actual,
    nativeChatRowOffersFork: (...args: Parameters<typeof actual.nativeChatRowOffersFork>) => {
      offers.checks++
      return actual.nativeChatRowOffersFork(...args)
    }
  }
})

function row(id: string, role: 'user' | 'assistant', sequence: number): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text: id }],
    timestamp: sequence,
    source: 'transcript',
    journalPosition: { sequence, index: 0 }
  }
}

function tool(id: string, sequence: number): NativeChatMessage {
  return {
    ...row(id, 'assistant', sequence),
    blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }]
  }
}

/** `turns` finished turns, then a running one, laid out as the transcript draws them. */
function conversation(turns: { ask: string; replies: NativeChatMessage[] }[], working: boolean) {
  const messages = turns.flatMap((turn, index) => [
    row(turn.ask, 'user', index * 10_000),
    ...turn.replies
  ])
  const turnKeys = turns.flatMap((turn) => [turn.ask, ...turn.replies.map(() => turn.ask)])
  const latestTurnKey = turns.at(-1)?.ask
  const input: NativeChatTranscriptSlotsInput = {
    messages,
    turnKeys,
    liveTurnKey: working ? latestTurnKey : undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(turns.map((turn) => turn.ask)),
    isWorking: working,
    lifecycleWorking: false
  }
  return { input, latestTurnKey, rootRows: messages.length }
}

function offer(
  fork: 'checkpoint' | 'tip',
  forkableItemIds: ReadonlySet<string>,
  latestTurnKey: string | undefined,
  contextFloorSequence = 0
) {
  return {
    chat: { support: { kind: 'known', fork }, contextFloorSequence, forkableItemIds },
    latestTurnKey
  } as const
}

describe('the side chat fork point the transcript finds while laying out', () => {
  const finished = (index: number) => ({
    ask: `ask-${index}`,
    replies: [row(`reply-${index}`, 'assistant', index * 10_000 + 1)]
  })

  it('forks a running chat through its last finished response, or waits at a tip', () => {
    const live = { ask: 'ask-live', replies: [row('reply-live', 'assistant', 99_001)] }
    const forkable = new Set(['reply-1', 'reply-live'])
    const { input, latestTurnKey } = conversation([finished(1), live], true)

    expect(
      buildNativeChatTranscript({
        ...input,
        forkOffer: offer('checkpoint', forkable, latestTurnKey)
      }).forkPoint
    ).toEqual({ kind: 'ready', throughItemId: 'reply-1' })
    expect(
      buildNativeChatTranscript({ ...input, forkOffer: offer('tip', forkable, latestTurnKey) })
        .forkPoint
    ).toEqual({ kind: 'reply-running' })

    const done = conversation([finished(1), live], false)
    expect(
      buildNativeChatTranscript({
        ...done.input,
        forkOffer: offer('tip', forkable, done.latestTurnKey)
      }).forkPoint
    ).toEqual({ kind: 'ready', throughItemId: 'reply-live' })
  })

  it('has nothing to fork above a /clear', () => {
    const { input, latestTurnKey } = conversation([finished(1)], false)

    expect(
      buildNativeChatTranscript({
        ...input,
        forkOffer: offer('checkpoint', new Set(['reply-1']), latestTurnKey, 50_000)
      }).forkPoint
    ).toEqual({ kind: 'no-reply' })
  })

  it.each([100, 1000])(
    'decides each of %i tool-only turns once per layout, and nothing without a listener',
    (size) => {
      const history = Array.from({ length: size }, (_, index) => ({
        ask: `ask-${index}`,
        replies: [tool(`tool-${index}`, index * 10_000 + 1)]
      }))
      const live = { ask: 'ask-live', replies: [row('streaming', 'assistant', 99_999_001)] }
      const { input, latestTurnKey, rootRows } = conversation([...history, live], true)
      // The live reply is forkable; the tool calls never are.
      const forkOffer = offer('checkpoint', new Set(['streaming']), latestTurnKey)

      offers.checks = 0
      const point = buildNativeChatTranscript({ ...input, forkOffer }).forkPoint
      expect(point).toEqual({ kind: 'reply-running' })
      expect(offers.checks).toBeLessThanOrEqual(rootRows)

      offers.checks = 0
      expect(buildNativeChatTranscript(input).forkPoint).toBeNull()
      expect(offers.checks).toBe(0)
    }
  )
})
