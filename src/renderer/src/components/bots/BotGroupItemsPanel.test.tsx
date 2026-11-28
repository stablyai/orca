// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setBotHostListing } from '@/lib/bot-catalog-snapshot'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { BotItemFilter } from '../../../../shared/bots/bot-item-groups'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'
import { BotGroupItemsPanel } from './BotGroupItemsPanel'

const group: BotGroup = {
  id: 'group',
  name: 'Release crew',
  hostId: 'local',
  revision: 1,
  createdAt: 1,
  folder: 'release-crew',
  folderWorkspaceId: 'workspace',
  replyMode: { kind: 'mentions' },
  members: [
    { botId: 'a', sessionId: 'room-a' },
    { botId: 'b', sessionId: 'room-b' }
  ]
}
const planned = makeTestBotItem(1, {
  status: 'planned',
  owner: { botId: 'a', name: 'Release bot' },
  chat: { kind: 'chat', id: 'room-a', title: 'Release crew' }
})
const first = { id: 'a', name: 'Release bot', hostId: 'local', avatar: null, paused: true }
const second = { ...first, id: 'b', name: 'Docs bot' }
let members = [first, second]
let outside = 0
let capturedFilter: BotItemFilter | undefined
let capturedMembers: readonly { id: string; hostId: string }[] = []
let paneBot: { id: string } | null = null
// A function read keeps TS from narrowing paneBot after the test resets it.
const currentPaneBot = (): { id: string } | null => paneBot

vi.mock('@/lib/bot-catalog', () => ({ useBots: () => members }))
vi.mock('./BotGroupPanelHeader', () => ({ BotGroupPanelHeader: () => null }))
vi.mock('./items/BotItemPane', () => ({
  BotItemPane: ({ bot }: { bot: { id: string } }) => {
    paneBot = bot
    return null
  }
}))
vi.mock('./use-bot-group-items', () => ({
  useBotGroupItems: (shown: typeof capturedMembers, filter: BotItemFilter) => {
    capturedMembers = shown
    capturedFilter = filter
    return {
      ready: true,
      offline: false,
      outside,
      needsYou: outside,
      working: 0,
      needs: [],
      stoppedForSignIn: [],
      shown: [planned],
      openCounts: new Map(),
      botOf: () => first,
      // The planned row is the paired member's while it's read.
      botOfUid: () => shown.find((bot) => bot.id === 'p') ?? null,
      seenOf: () => 'e10',
      list: {
        groups: {
          needs_you: [],
          working: [],
          waiting: [],
          planned: [planned],
          snoozed: [],
          stale: [],
          closed: []
        },
        closedTotal: 0,
        loadMoreClosed: null,
        closedEnded: true
      }
    }
  }
}))

afterEach(cleanup)

it('shows the all-clear when one member resumes in an otherwise idle group', () => {
  members = [first, second]
  outside = 0
  const panel = render(<BotGroupItemsPanel group={group} />, { wrapper: TooltipProvider })
  expect(screen.queryByRole('status')).toBeNull()
  members = [first, { ...second, paused: false }]
  panel.rerender(<BotGroupItemsPanel group={group} />)
  expect(screen.getByRole('status')).toBeTruthy()
})

it('reads all member work by default', () => {
  render(<BotGroupItemsPanel group={group} />, { wrapper: TooltipProvider })
  expect(capturedFilter?.chatIds).toBeNull()
})

const paired = { ...first, id: 'p', name: 'Paired bot', hostId: 'runtime:env-1' }
const remote = {
  environmentId: 'env-1',
  botId: 'p',
  chatSessionId: 'chat-p',
  computer: 'Studio',
  joinedAfter: 0,
  name: 'Paired bot',
  avatar: null,
  agent: 'claude' as const
}

function pairedHost(state: 'live' | 'offline'): void {
  setBotHostListing({
    hosts: [
      { hostId: 'local', state: 'live' },
      { hostId: 'runtime:env-1', state },
      { hostId: 'runtime:env-2', state: 'live' }
    ],
    updateNeeded: []
  })
}

function shownMembers(): string[] {
  render(<BotGroupItemsPanel group={{ ...group, remoteMembers: [remote] }} />, {
    wrapper: TooltipProvider
  })
  return capturedMembers.map(({ id, hostId }) => `${hostId}/${id}`)
}

it('reads the members on paired computers too', () => {
  pairedHost('live')
  members = [{ ...second, hostId: 'runtime:env-2' }, paired, first, second]
  expect(shownMembers()).toEqual(['local/a', 'local/b', 'runtime:env-1/p'])
})

it('leaves out a member whose paired computer is offline', () => {
  pairedHost('offline')
  members = [paired, first, second]
  expect(shownMembers()).toEqual(['local/a', 'local/b'])
})

it("keeps an open paired member's item up while its computer is offline", () => {
  pairedHost('live')
  members = [paired, first, second]
  render(<BotGroupItemsPanel group={{ ...group, remoteMembers: [remote] }} />, {
    wrapper: TooltipProvider
  })
  fireEvent.click(screen.getByRole('button', { name: /Planned/ }))
  fireEvent.click(screen.getByText(planned.title))
  expect(paneBot?.id).toBe('p')
  paneBot = null
  act(() => pairedHost('offline'))
  expect(currentPaneBot()?.id).toBe('p')
  expect(capturedMembers.map(({ id }) => id)).toContain('p')
})
