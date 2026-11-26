// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

const NOW = Date.parse('2026-11-14T12:00:00Z')

const BOT: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

vi.mock('./use-bot-items', () => ({
  useBotChatItems: () => ({ read: null, failed: false, retry: vi.fn(), readMore: vi.fn() }),
  readMoreBotItems: vi.fn()
}))
vi.mock('../AddConnectorDialog', () => ({ manageConnectors: vi.fn() }))
vi.mock('../bot-automation-open', () => ({ openBotAutomation: vi.fn() }))

import { BOT_ITEM_NO_FILTER } from '../../../../../shared/bots/bot-item-groups'
import type { BotNeedsYouAsks } from '../BotNeedsYouSection'
import { BotItemsSection } from './BotItemsSection'
import { useBotItemsShownList } from './use-bot-items-shown-list'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const NO_ASKS: BotNeedsYouAsks = { needs: [], stoppedForSignIn: [], itemOf: () => null }

const REQUEST: BotNeedsYouAsks = {
  needs: [
    {
      kind: 'connector',
      key: 'connector:github',
      connector: {
        kind: 'github',
        key: 'github',
        title: { service: 'GitHub', name: null },
        needsOwner: true
      }
    }
  ],
  stoppedForSignIn: [],
  itemOf: () => null
}
const planned = makeTestBotItem(3, { status: 'planned', lastActivityAt: NOW })
const read = { items: [planned], counts: {}, seenEventId: 'e0' }

function Section({ asks }: { asks: BotNeedsYouAsks }): React.JSX.Element {
  const list = useBotItemsShownList(BOT, read, BOT_ITEM_NO_FILTER, NOW, 'e0')
  return (
    <BotItemsSection
      bot={BOT}
      list={list}
      seenEventId={read.seenEventId}
      filter={BOT_ITEM_NO_FILTER}
      onFilter={() => {}}
      now={NOW}
      focusUid={null}
      onOpen={() => {}}
      botRead={{ state: 'ready', retry: () => {} }}
      asks={asks}
      offline={false}
      focusFallback={{ current: null }}
    />
  )
}

it('shows the idle status above planned items after the owner resolves the last request', () => {
  const panel = render(<Section asks={REQUEST} />, { wrapper: TooltipProvider })
  expect(screen.queryByRole('status')).toBeNull()

  panel.rerender(<Section asks={NO_ASKS} />)
  const status = screen.getByRole('status')
  const plannedFold = screen.getByRole('button', { name: /Planned/ })
  expect(
    status.compareDocumentPosition(plannedFold) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
})
