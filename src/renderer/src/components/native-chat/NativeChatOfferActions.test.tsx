// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotImportPlan } from '../../../../shared/bots/bot-import-cards'
import type { BotOfferAnswer } from '../../../../shared/bots/bot-offer-answers'
import { applyBotUpdates, type BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'

// The host's saved bots: what a reload reads back.
const host = vi.hoisted((): { bots: Bot[] } => ({ bots: [] }))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params?: BotUpdateParams) => {
    if (method === 'bots.update' && params) {
      host.bots = host.bots.map((bot) =>
        bot.id === params.botId ? applyBotUpdates(bot, params.updates) : bot
      )
      return { bot: host.bots.find((bot) => bot.id === params.botId) }
    }
    return { bots: host.bots }
  }
}))

import { publishBots } from '@/lib/bot-catalog-snapshot'
import {
  NativeChatBotKickoffContext,
  type NativeChatBotKickoffView
} from './native-chat-bot-kickoff-view'
import { NativeChatImportPlanCard } from './NativeChatImportPlanCard'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'

const atlas: Bot = {
  id: 'atlas',
  name: 'Atlas',
  hostId: 'local',
  folder: 'atlas',
  folderWorkspaceId: 'atlas-home',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

function kickoffView(send: NativeChatBotKickoffView['send']): NativeChatBotKickoffView {
  return {
    live: false,
    bot: null,
    firstScreen: null,
    firstKickoffId: null,
    send,
    sendBlockedReason: () => undefined
  }
}

let send = vi.fn(async (_text: string) => true)

function show(cards: ReactNode): void {
  const view = kickoffView(send)
  render(
    <NativeChatBotKickoffContext.Provider value={view}>
      {cards}
    </NativeChatBotKickoffContext.Provider>
  )
}

/** Lets the answer reach the host, then draws `cards` again from what the host saved. */
async function reload(cards: ReactNode): Promise<void> {
  await act(async () => {})
  cleanup()
  publishBots(host.bots)
  show(cards)
}

/** Presses `button` and lets the chat take the message. */
async function press(button: HTMLElement): Promise<void> {
  fireEvent.click(button)
  await act(async () => {})
}

function Offer({ id }: { id: string }): React.JSX.Element {
  const offer = useNativeChatOffer(atlas.id, id)
  return (
    <section data-testid={id}>
      <NativeChatOfferActions offer={offer}>
        <button type="button">Connect</button>
      </NativeChatOfferActions>
    </section>
  )
}

const notNowIn = (id: string) =>
  within(screen.getByTestId(id)).queryByRole('button', { name: 'Not now' })

beforeEach(() => {
  send = vi.fn(async (_text: string) => true)
  toastError.mockClear()
  host.bots = [atlas]
  publishBots(host.bots)
})

afterEach(cleanup)

describe('an offer card', () => {
  it('sends once on a double click', async () => {
    show(<Offer id="a" />)
    const dismiss = screen.getByRole('button', { name: 'Not now' })
    await act(async () => {
      fireEvent.click(dismiss)
      fireEvent.click(dismiss)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('sends nothing when another device answered first, and shows that answer', async () => {
    host.bots = [{ ...atlas, offerAnswers: [{ cardId: 'a', dismissed: true }] }]
    show(<Offer id="a" />)
    await press(screen.getByRole('button', { name: 'Not now' }))
    expect(send).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(notNowIn('a')).toBeNull()
  })

  it('sends no Not now once another device took the action', async () => {
    host.bots = [{ ...atlas, offerAnswers: [{ cardId: 'a', sent: { chosen: [] } }] }]
    show(<Offer id="a" />)
    await press(screen.getByRole('button', { name: 'Not now' }))
    expect(send).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('keeps another card’s Not now after a reload, and the dismissed one’s gone', async () => {
    const cards = (
      <>
        <Offer id="a" />
        <Offer id="b" />
      </>
    )
    show(cards)
    await press(within(screen.getByTestId('b')).getByRole('button', { name: 'Not now' }))
    expect(send).toHaveBeenCalledWith('Dismiss')
    expect(notNowIn('a')).not.toBeNull()
    expect(notNowIn('b')).toBeNull()
    expect(within(screen.getByTestId('b')).getByRole('button', { name: 'Connect' })).toBeTruthy()

    await reload(cards)
    expect(notNowIn('a')).not.toBeNull()
    expect(notNowIn('b')).toBeNull()
  })

  it('keeps an earlier import plan’s Import after a later plan is imported, through a reload', async () => {
    const first: BotImportPlan = {
      botId: atlas.id,
      app: 'Molty',
      name: 'First',
      items: [{ group: 'comes', what: 'Memory', why: 'Keep it' }]
    }
    const second: BotImportPlan = { ...first, name: 'Second' }
    const cards = (
      <>
        <section data-testid="first">
          <NativeChatImportPlanCard plan={first} messageId="a" />
        </section>
        <section data-testid="second">
          <NativeChatImportPlanCard plan={second} messageId="b" />
        </section>
      </>
    )
    show(cards)
    await press(within(screen.getByTestId('second')).getByRole('button', { name: 'Import 1 item' }))
    expect(
      within(screen.getByTestId('first')).getByRole('button', { name: 'Import 1 item' })
    ).toBeTruthy()
    await reload(cards)
    expect(
      within(screen.getByTestId('first')).getByRole('button', { name: 'Import 1 item' })
    ).toBeTruthy()
    expect(within(screen.getByTestId('second')).getByText('Asked to import 1 item')).toBeTruthy()
  })

  it('keeps the ticks it imported with when two items share a label, through a reload', async () => {
    const card = (
      <NativeChatImportPlanCard
        plan={{
          botId: atlas.id,
          app: 'Molty',
          name: 'Molty',
          items: [
            { group: 'comes', what: 'Memory', to: 'Soul', why: 'Personality' },
            { group: 'changed', what: 'Memory', to: 'Facts', why: 'Facts' }
          ]
        }}
        messageId="plan"
      />
    )
    show(card)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    await press(screen.getByRole('button', { name: 'Import 1 item' }))
    const ticks = () =>
      screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-checked'))
    expect(ticks()).toEqual(['true', 'false'])
    expect(screen.getByText('Asked to import 1 item')).toBeTruthy()
    await reload(card)
    expect(ticks()).toEqual(['true', 'false'])
    expect(screen.getByText('Asked to import 1 item')).toBeTruthy()
  })

  it('keeps an old card answered however many cards are answered after it, through a reload', async () => {
    const plan: BotImportPlan = {
      botId: atlas.id,
      app: 'Molty',
      name: 'Molty',
      items: [{ group: 'comes', what: 'Memory', why: 'Keep it' }]
    }
    const later = Array.from({ length: 250 }, (_, index): BotOfferAnswer => ({
      cardId: `later-${index}`,
      dismissed: true
    }))
    host.bots = [{ ...atlas, offerAnswers: [{ cardId: 'old', sent: { chosen: ['0'] } }, ...later] }]
    publishBots(host.bots)
    const cards = (
      <>
        <section data-testid="old">
          <NativeChatImportPlanCard plan={plan} messageId="old" />
        </section>
        <Offer id="newest" />
      </>
    )
    show(cards)
    await press(within(screen.getByTestId('newest')).getByRole('button', { name: 'Not now' }))
    await reload(cards)
    expect(within(screen.getByTestId('old')).getByText('Asked to import 1 item')).toBeTruthy()
    expect(within(screen.getByTestId('old')).queryByRole('button')).toBeNull()
  })

  it('keeps Import to press again when the chat refuses the message, through a reload', async () => {
    send = vi.fn(async (_text: string) => false)
    const card = (
      <NativeChatImportPlanCard
        plan={{
          botId: atlas.id,
          app: 'Molty',
          name: 'Molty',
          items: [{ group: 'comes', what: 'Memory', why: 'Keep it' }]
        }}
        messageId="plan"
      />
    )
    show(card)
    await press(screen.getByRole('button', { name: 'Import 1 item' }))
    expect(toastError).toHaveBeenCalledWith("Couldn't send that to the bot. Try again.")
    expect(screen.getByRole('button', { name: 'Import 1 item' })).toBeTruthy()
    await reload(card)
    expect(screen.getByRole('button', { name: 'Import 1 item' })).toBeTruthy()
    expect(screen.queryByText('Asked to import 1 item')).toBeNull()
  })
})
