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

import type { BotAutomationRow } from '../../../../../shared/bots/bot-automation-rows'
import { BOT_ITEM_NO_FILTER } from '../../../../../shared/bots/bot-item-groups'
import type { BotItemsRead } from './use-bot-items'
import type { BotNeedsYouAsks } from '../BotNeedsYouSection'
import type { BotConnectorEntry } from '../bot-connector-entries'
import type { BotHostReadState } from '../use-bot-host-read'
import { BotItemsSection } from './BotItemsSection'
import { useBotItemsShownList } from './use-bot-items-shown-list'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const NO_ASKS: BotNeedsYouAsks = { needs: [], stoppedForSignIn: [], itemOf: () => null }

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only these fields.
const LINEAR = {
  kind: 'linear',
  key: 'linear:w1',
  title: { service: 'Linear', name: null },
  needsOwner: true
} as BotConnectorEntry
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only these fields.
const STOPPED = {
  key: 'a1',
  latestRunId: 'r1',
  automation: { id: 'a1', name: 'Digest' }
} as BotAutomationRow
const SIGN_IN: BotNeedsYouAsks = {
  needs: [{ kind: 'connector', key: 'connector:linear:w1', connector: LINEAR }],
  stoppedForSignIn: [STOPPED],
  itemOf: () => null
}

const EMPTY_READ: BotItemsRead = { items: [], counts: {}, seenEventId: 'e0' }

function Section({
  read = EMPTY_READ,
  state = 'ready',
  asks = NO_ASKS
}: {
  read?: BotItemsRead | null
  state?: BotHostReadState
  asks?: BotNeedsYouAsks
}): React.JSX.Element {
  const list = useBotItemsShownList(BOT, read, BOT_ITEM_NO_FILTER, NOW, 'e0')
  return (
    <BotItemsSection
      bot={BOT}
      list={list}
      seenEventId={read ? 'e0' : null}
      filter={BOT_ITEM_NO_FILTER}
      onFilter={() => {}}
      now={NOW}
      focusUid={null}
      onOpen={() => {}}
      botRead={{ state, retry: () => {} }}
      asks={asks}
      offline={false}
      focusFallback={{ current: null }}
    />
  )
}

it('lists Orca’s asks while items load and after', () => {
  const { rerender } = render(<Section read={null} state="loading" asks={SIGN_IN} />, {
    wrapper: TooltipProvider
  })

  expect(screen.getByRole('button', { name: 'Open Linear' })).toBeTruthy()
  const loading = screen.getByRole('status')
  expect(loading.textContent).toBe('Loading items…')
  expect(loading.hasAttribute('aria-busy')).toBe(false)

  const asked = makeTestBotItem(2, { status: 'needs_you', lastActivityAt: NOW })
  rerender(
    <Section
      read={{ items: [asked], counts: { needs_you: 1 }, seenEventId: 'e0' }}
      asks={SIGN_IN}
    />
  )
  expect(screen.getByRole('button', { name: 'Open Linear' })).toBeTruthy()
  expect(screen.getByText('Item 2')).toBeTruthy()

  rerender(<Section asks={SIGN_IN} />)
  expect(screen.queryByText('Nothing needs you and nothing is running.')).toBeNull()

  const planned = makeTestBotItem(3, { status: 'planned', lastActivityAt: NOW })
  rerender(<Section read={{ items: [planned], counts: {}, seenEventId: 'e0' }} />)
  expect(screen.getByText('Nothing needs you and nothing is running.')).toBeTruthy()
})
