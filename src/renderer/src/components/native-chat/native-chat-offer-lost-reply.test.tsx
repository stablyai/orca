// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  withBotOfferAnswer,
  type BotOfferAnswer,
  type BotOfferAnswerUpdate,
  type BotOfferSelection
} from '../../../../shared/bots/bot-offer-answers'
import { runtimeHostStatusFailure } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useNativeChatOffer } from './NativeChatOfferActions'
import {
  NativeChatBotKickoffContext,
  type NativeChatBotKickoffView
} from './native-chat-bot-kickoff-view'

// The paired server's copy of the card answers, and what it told the agent.
const host = vi.hoisted(
  (): {
    answers: BotOfferAnswer[]
    told: string[]
    lose: boolean
    /** The server saves the card itself and returns the saved answer. */
    confirms: boolean
    refusedClaims: number
    toasts: number
    refreshes: number
    published: BotOfferAnswer[]
  } => ({
    answers: [],
    told: [],
    lose: false,
    confirms: false,
    refusedClaims: 0,
    toasts: 0,
    refreshes: 0,
    published: []
  })
)
vi.mock('@/lib/bot-catalog', () => ({
  useCardBot: () => ({
    bot: { id: 'bot', offerAnswers: host.answers },
    ref: { hostId: 'server', id: 'bot' }
  }),
  updateBot: async (_ref: unknown, updates: { offerAnswer: BotOfferAnswerUpdate }) => {
    try {
      host.answers = withBotOfferAnswer(host.answers, updates.offerAnswer)
    } catch (error) {
      host.refusedClaims++
      throw error
    }
  },
  refreshBotHost: async () => {
    host.refreshes++
  }
}))
vi.mock('@/lib/bot-offer-answer-publish', () => ({
  publishBotOfferAnswer: (_ref: unknown, answer: BotOfferAnswer) => {
    host.published.push(answer)
  }
}))
vi.mock('@/lib/bot-hosts', () => ({
  callBotRpc: async (
    _ref: unknown,
    _method: string,
    params: { text: string; answer?: BotOfferSelection }
  ) => {
    const { answer } = params
    const saved = answer && host.answers.find((entry) => entry.cardId === answer.cardId)
    if (saved) {
      // The server already took this card's answer: it returns it and tells the agent nothing.
      return { sent: true, answer: saved }
    }
    host.told.push(params.text)
    if (answer) {
      host.answers = withBotOfferAnswer(host.answers, answer)
    }
    if (host.lose) {
      // The server took the answer; its reply never came back.
      throw new RuntimeRpcCallError(
        runtimeHostStatusFailure(
          'runtime_timeout',
          'Timed out waiting for the remote Orca runtime to respond.'
        )
      )
    }
    return { sent: true }
  }
}))
// Every host takes card answers; only a newer one confirms them (bots.offer-answer.v2).
vi.mock('../bots/bot-host-capability', () => ({
  botHostTakes: (_ref: unknown, capability: string) =>
    capability !== 'bots.offer-answer.v2' || host.confirms
}))
vi.mock('sonner', () => ({
  toast: {
    error: () => {
      host.toasts++
    }
  }
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only sessionId, send and sendBlockedReason.
const view = {
  sessionId: 'chat-1',
  send: async () => false,
  sendBlockedReason: () => undefined
} as unknown as NativeChatBotKickoffView
const wrapper = ({ children }: { children: ReactNode }) => (
  <NativeChatBotKickoffContext.Provider value={view}>
    {children}
  </NativeChatBotKickoffContext.Provider>
)

afterEach(() => {
  host.answers = []
  host.told = []
  host.lose = false
  host.confirms = false
  host.refusedClaims = 0
  host.toasts = 0
  host.refreshes = 0
  host.published = []
})

function press(): void {
  renderHook(() => useNativeChatOffer('bot', 'card'), { wrapper }).result.current.dismiss()
}

it('tells the agent once when a card answer is sent', async () => {
  press()
  await vi.waitFor(() => expect(host.answers).toEqual([{ cardId: 'card', dismissed: true }]))
  expect(host.told).toHaveLength(1)
})

it('tells the agent once when the reply to a card answer is lost and the card is pressed again', async () => {
  host.lose = true
  press()
  await vi.waitFor(() => expect(host.toasts).toBe(1))
  host.lose = false
  press()
  await vi.waitFor(() => expect(host.refusedClaims).toBe(1))
  expect(host.told).toHaveLength(1)
})

it('tells a confirming server once when the reply to a card answer is lost and the card is pressed again', async () => {
  host.confirms = true
  host.lose = true
  press()
  // The lost reply is asked again at once; the server returns the answer it already took.
  await vi.waitFor(() => expect(host.refreshes).toBe(1))
  expect(host.answers).toEqual([{ cardId: 'card', dismissed: true }])
  // The card shows the saved answer even when the refresh is held back by another update.
  expect(host.published).toEqual([{ cardId: 'card', dismissed: true }])
  expect(host.toasts).toBe(0)
  press()
  await vi.waitFor(() => expect(host.refreshes).toBe(2))
  expect(host.told).toHaveLength(1)
  expect(host.toasts).toBe(0)
})
