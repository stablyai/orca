// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import {
  DashboardBotAsks,
  DashboardBotAsksFeed,
  PopoutDashboardBotAsks,
  openRelayedDashboardBotAsk,
  toDashboardBotAsk
} from './DashboardBotAsks'
import { readDashboardBotAsks } from './dashboard-bot-asks-feed'

// Never stale, so the fixed activity times below stay in Needs you.
const bot: Bot = {
  id: 'bot-a',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: 'mascot:Q1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  itemsStale: 'never',
  createdAt: 1,
  updatedAt: 1
}

const calls = vi.hoisted(() => ({ openHome: vi.fn(() => true), openItem: vi.fn() }))
vi.mock('@/lib/bot-catalog', () => ({
  openBotHome: calls.openHome,
  readBots: () => [bot],
  subscribeToBotChanges: () => () => {},
  useBots: () => [bot],
  useBotsEnabled: () => true,
  useListedBotItemsNeedingOwner: () => 1
}))
vi.mock('@/components/bots/items/bot-item-open', () => ({ openBotItem: calls.openItem }))
vi.mock('@/components/bots/BotAvatar', () => ({
  BotAvatar: () => null,
  CarriedBotAvatar: () => null
}))
vi.mock('@/components/bots/items/use-bot-items', () => ({
  useBotItems: () => ({
    read: {
      items: [
        makeTestBotItem(7, {
          status: 'needs_you',
          title: 'Pick a release date',
          question: { eventId: 'e9', text: 'Ship on **Friday** or Monday?' },
          lastActivityAt: 1_000
        }),
        makeTestBotItem(8, { status: 'working', title: 'Draft notes', lastActivityAt: 1_000 })
      ],
      counts: {},
      seenEventId: 'e10'
    }
  })
}))

afterEach(cleanup)

describe('DashboardBotAsks', () => {
  it('shows only the items asking the owner, and opens one in its bot’s panel', () => {
    const opened = vi.fn()
    render(<DashboardBotAsks onOpened={opened} />)

    expect(screen.getByText('Pick a release date')).toBeTruthy()
    expect(screen.getByText('Ship on Friday or Monday?')).toBeTruthy()
    expect(screen.queryByText('Draft notes')).toBeNull()

    fireEvent.click(screen.getByText('Pick a release date'))

    expect(calls.openHome).toHaveBeenCalledWith(bot)
    expect(calls.openItem).toHaveBeenCalledWith(bot, 'uid-7')
    expect(opened).toHaveBeenCalledOnce()
  })

  it('falls back to the question text when its gist is empty, as a fresh --ask leaves it', () => {
    const ask = toDashboardBotAsk(
      bot,
      makeTestBotItem(9, {
        status: 'needs_you',
        question: { eventId: 'e2', text: 'Lead with the dashboard?\n   - Yes', gist: '' }
      }),
      1_000
    )
    expect(ask.question).toBe('Lead with the dashboard?')
  })

  it('feeds the pop-out the same asks while mounted, and drops them on unmount', () => {
    const { unmount } = render(<DashboardBotAsksFeed />)

    expect(readDashboardBotAsks()).toEqual([
      {
        botHostId: 'local',
        botId: 'bot-a',
        botName: 'Reviewer',
        botAvatar: 'mascot:Q1',
        itemUid: 'uid-7',
        title: 'Pick a release date',
        question: 'Ship on Friday or Monday?',
        number: 7,
        activityAt: 1_000
      }
    ])

    unmount()
    expect(readDashboardBotAsks()).toEqual([])
  })

  it('asks the main window to open a pop-out card, and opens a relayed ask by its bot', () => {
    const openBotItem = vi.fn(async () => {})
    vi.stubGlobal('api', { dashboard: { openBotItem } })
    render(<PopoutDashboardBotAsks asks={[{ ...relayedAsk, question: '' }]} />)

    fireEvent.click(screen.getByText('Pick a release date'))
    expect(openBotItem).toHaveBeenCalledWith(openArgs)

    calls.openItem.mockClear()
    expect(openRelayedDashboardBotAsk(openArgs)).toBe(true)
    expect(calls.openItem).toHaveBeenCalledWith(bot, 'uid-7')
    expect(openRelayedDashboardBotAsk({ ...openArgs, botId: 'gone' })).toBe(false)
    vi.unstubAllGlobals()
  })
})

const openArgs = { botHostId: 'local', botId: 'bot-a', itemUid: 'uid-7' } as const
const relayedAsk = {
  ...openArgs,
  botName: 'Reviewer',
  botAvatar: null,
  title: 'Pick a release date',
  question: 'Ship on Friday or Monday?',
  number: 7,
  activityAt: 1_000
}
