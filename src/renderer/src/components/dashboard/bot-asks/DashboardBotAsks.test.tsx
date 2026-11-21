// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { DashboardBotAsks } from './DashboardBotAsks'

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
vi.mock('@/components/bots/BotAvatar', () => ({ BotAvatar: () => null }))
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
})
