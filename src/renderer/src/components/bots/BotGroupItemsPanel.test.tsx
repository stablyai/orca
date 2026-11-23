// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BotGroup } from '../../../../shared/bots/bot-group'
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

vi.mock('@/lib/bot-catalog', () => ({ useBots: () => members }))
vi.mock('./BotGroupPanelHeader', () => ({ BotGroupPanelHeader: () => null }))
vi.mock('./items/BotItemPane', () => ({ BotItemPane: () => null }))
vi.mock('./use-bot-group-items', () => ({
  useBotGroupItems: () => ({
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
  })
}))

afterEach(cleanup)

it('shows the all-clear only after an outside request is resolved', () => {
  members = [first, { ...second, paused: false }]
  outside = 1
  const panel = render(<BotGroupItemsPanel group={group} />, { wrapper: TooltipProvider })
  expect(screen.queryByRole('status')).toBeNull()
  outside = 0
  panel.rerender(<BotGroupItemsPanel group={group} />)
  expect(screen.getByRole('status')).toBeTruthy()
})

it('shows the all-clear when one member resumes in an otherwise idle group', () => {
  members = [first, second]
  outside = 0
  const panel = render(<BotGroupItemsPanel group={group} />, { wrapper: TooltipProvider })
  expect(screen.queryByRole('status')).toBeNull()
  members = [first, { ...second, paused: false }]
  panel.rerender(<BotGroupItemsPanel group={group} />)
  expect(screen.getByRole('status')).toBeTruthy()
})
