// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotCreateOffer } from '../../../../shared/bots/bot-proposal'

const mocks = vi.hoisted(() => ({
  bots: new Array<Bot>(),
  createBot: vi.fn(),
  openBotHomeTabById: vi.fn()
}))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => mocks.bots,
  useCardBot: (id: string) => ({
    bot: mocks.bots.find((bot: { id: string }) => bot.id === id) ?? null,
    ref: { hostId: 'local', id }
  }),
  createBot: mocks.createBot,
  openBotHomeTabById: mocks.openBotHomeTabById
}))
vi.mock('../bots/NewBotDialog', () => ({
  NewBotDialog: ({ origin, fromOffer }: { origin?: string; fromOffer?: unknown }) => (
    <div role="dialog" data-from-offer={JSON.stringify(fromOffer)}>
      {origin}
    </div>
  )
}))

import { useAppStore } from '@/store'
import { NativeChatBotCreateOfferCard } from './NativeChatBotCreateOfferCard'

function makeTestBot(overrides: Partial<Bot>): Bot {
  return {
    id: 'atlas',
    name: 'Atlas',
    hostId: 'local',
    folder: 'atlas',
    folderWorkspaceId: 'atlas-home',
    agent: 'codex',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const offer: BotCreateOffer = {
  botId: 'atlas',
  offerId: 'offer-1',
  offeredAt: 1000,
  proposal: {
    name: 'Cutter',
    purpose: 'Tracks what’s blocking the 1.5 release.',
    watches: 'Pull requests and checks for milestone 1.5',
    reports: 'Here, weekday mornings',
    templateId: 'release',
    mascot: 'K2',
    worktrees: [
      { id: 'w1', name: 'release-checklist' },
      { id: 'w2', name: 'mobile-keyboard-fix' },
      { id: 'w3', name: 'changelog-1-5' }
    ]
  }
}

function show(bots: Bot[]) {
  mocks.bots = bots
  render(<NativeChatBotCreateOfferCard offer={offer} messageId="m1" fallback="fallback line" />)
}

afterEach(() => {
  cleanup()
  mocks.createBot.mockReset()
  mocks.openBotHomeTabById.mockReset()
})

describe('the new-bot card', () => {
  it('creates nothing until Create bot, then creates the proposal on the proposer’s agent', async () => {
    mocks.createBot.mockResolvedValue(makeTestBot({ id: 'cutter', name: 'Cutter' }))
    show([makeTestBot({})])
    expect(screen.getByText('Takes over 3 workspaces')).toBeTruthy()
    expect(mocks.createBot).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }))
    await waitFor(() => expect(mocks.createBot).toHaveBeenCalledTimes(1))
    expect(mocks.createBot).toHaveBeenCalledWith('local', {
      name: 'Cutter',
      agent: 'codex',
      avatar: 'mascot:K2',
      handOff: [
        { id: 'w1', name: 'release-checklist' },
        { id: 'w2', name: 'mobile-keyboard-fix' },
        { id: 'w3', name: 'changelog-1-5' }
      ],
      seed: {
        purpose: 'Tracks what’s blocking the 1.5 release.',
        watches: 'Pull requests and checks for milestone 1.5',
        reports: 'Here, weekday mornings',
        templateId: 'release'
      },
      fromTemplate: { id: 'release', skills: ['release-readiness'] },
      fromOffer: { botId: 'atlas', offerId: 'offer-1' }
    })
  })

  it('Edit opens New bot naming who proposed it', () => {
    show([makeTestBot({})])
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toBe('From Release readiness, proposed by Atlas')
    // A bot created from Edit is recorded against this card too.
    expect(dialog.getAttribute('data-from-offer')).toBe('{"botId":"atlas","offerId":"offer-1"}')
  })

  it('opens in place to what it watches, reports, takes over and its template', () => {
    show([makeTestBot({})])
    const toggle = screen.getByRole('button', { expanded: false })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Pull requests and checks for milestone 1.5')).toBeTruthy()
    expect(screen.getByText('Here, weekday mornings')).toBeTruthy()
    expect(screen.getByText('release-checklist, mobile-keyboard-fix, changelog-1-5')).toBeTruthy()
    expect(screen.getByText('Release readiness')).toBeTruthy()
  })

  it('reads Created from the bot recorded against its id, whatever that bot is named now', () => {
    const atlas = makeTestBot({ acceptedOffers: [{ offerId: 'offer-1', botId: 'b9' }] })
    show([atlas, makeTestBot({ id: 'b9', name: 'Release', createdAt: 2000 })])
    expect(screen.getByText('Release')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create bot' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(mocks.openBotHomeTabById).toHaveBeenCalledWith(expect.objectContaining({ id: 'b9' }))
  })

  it('never takes another bot of the same name for the one it created', () => {
    show([makeTestBot({}), makeTestBot({ id: 'other', name: 'Cutter', createdAt: 2000 })])
    expect(screen.queryByText(/^Created/)).toBeNull()
    expect(screen.getByText('You already have a bot named Cutter.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy()
  })

  it('says it was deleted, with nothing to press, once the bot it created is gone', () => {
    show([makeTestBot({ acceptedOffers: [{ offerId: 'offer-1', botId: 'gone' }] })])
    expect(screen.getByText('Created, then deleted')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create bot' })).toBeNull()
  })

  it('claims a takeover only for the workspaces that are under the new bot now', () => {
    const atlas = makeTestBot({ acceptedOffers: [{ offerId: 'offer-1', botId: 'cutter' }] })
    const cutter = makeTestBot({ id: 'cutter', name: 'Cutter', folderWorkspaceId: 'cutter-home' })
    const under = (ids: string[]) =>
      useAppStore.setState({
        workspaceLineageByChildKey: Object.fromEntries(
          ids.map((id) => [
            `worktree:${id}`,
            {
              childWorkspaceKey: `worktree:${id}`,
              childInstanceId: null,
              parentWorkspaceKey: 'folder:cutter-home',
              parentInstanceId: null,
              origin: 'orchestration' as const,
              capture: {
                source: 'orchestration-context' as const,
                confidence: 'explicit' as const
              },
              createdAt: 3000
            }
          ])
        )
      })
    under([])
    show([atlas, cutter])
    expect(screen.getByText('Created · asked to take over 3 workspaces')).toBeTruthy()
    act(() => under(['w1', 'w2']))
    expect(screen.getByText('Created · took over 2 of 3 workspaces')).toBeTruthy()
    act(() => under(['w1', 'w2', 'w3']))
    expect(screen.getByText('Created · took over 3 workspaces')).toBeTruthy()
  })

  it('shows the host’s line for a proposer this window does not list', () => {
    show([])
    expect(screen.getByText('fallback line')).toBeTruthy()
  })
})
