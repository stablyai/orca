// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  withBotOfferAnswer,
  type BotOfferAnswer,
  type BotOfferAnswerUpdate
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
    refusedClaims: number
    toasts: number
  } => ({ answers: [], told: [], lose: false, refusedClaims: 0, toasts: 0 })
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
  }
}))
vi.mock('@/lib/bot-hosts', () => ({
  callBotRpc: async (_ref: unknown, _method: string, params: { text: string }) => {
    host.told.push(params.text)
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
vi.mock('../bots/bot-host-capability', () => ({ botHostTakes: () => true }))
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
  host.refusedClaims = 0
  host.toasts = 0
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
