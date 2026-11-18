// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItem } from '../../../../../shared/bots/bot-items'
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

function item(number: number, chatId: string): BotItem {
  return makeTestBotItem(number, {
    chat: { id: chatId, kind: 'chat', title: 'Release' },
    lastActivityAt: NOW
  })
}

const chat = vi.hoisted(() => ({ retry: vi.fn() }))

// The chat's own read landed once, then its re-read failed.
vi.mock('./use-bot-items', () => ({
  useBotChatItems: () => ({
    read: { items: [item(1, 'chat-release')], counts: { working: 1 }, seenEventId: 'e0' },
    failed: true,
    retry: chat.retry
  }),
  readMoreClosedItems: vi.fn()
}))
vi.mock('../AddConnectorDialog', () => ({ manageConnectors: vi.fn() }))
vi.mock('../bot-automation-open', () => ({ openBotAutomation: vi.fn() }))

import type { BotAutomationRow } from '../../../../../shared/bots/bot-automation-rows'
import type { BotItemFilter } from '../../../../../shared/bots/bot-item-groups'
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

const FILTER = { chatId: 'chat-release', needsYou: false }
const NO_FILTER = { chatId: null, needsYou: false }
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
  filter = FILTER,
  read = EMPTY_READ,
  state = 'ready',
  asks = NO_ASKS
}: {
  filter?: BotItemFilter
  read?: BotItemsRead | null
  state?: BotHostReadState
  asks?: BotNeedsYouAsks
}): React.JSX.Element {
  const list = useBotItemsShownList(BOT, read, filter, NOW, 'e0')
  return (
    <BotItemsSection
      bot={BOT}
      list={list}
      chats={[]}
      seenEventId={read ? 'e0' : null}
      filter={filter}
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

it('keeps a chat’s items up when their re-read fails, saying so, with Retry', () => {
  render(<Section />)

  expect(screen.getByText('Item 1')).toBeTruthy()
  expect(screen.getByText("Couldn't refresh items. Showing the last read.")).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(chat.retry).toHaveBeenCalledOnce()
})

it('lists Orca’s asks while items load and after, counting asks and items but not stopped runs', () => {
  const { rerender } = render(
    <Section filter={NO_FILTER} read={null} state="loading" asks={SIGN_IN} />
  )

  expect(screen.getByRole('button', { name: 'Open Linear' })).toBeTruthy()
  expect(screen.getByText('Loading items…')).toBeTruthy()
  expect(screen.getByRole('button', { expanded: true }).textContent).toBe('Needs you1')

  const asked = makeTestBotItem(2, { status: 'needs_you', lastActivityAt: NOW })
  rerender(
    <Section
      filter={NO_FILTER}
      read={{ items: [asked], counts: { needs_you: 1 }, seenEventId: 'e0' }}
      asks={SIGN_IN}
    />
  )
  expect(screen.getByRole('button', { name: 'Open Linear' })).toBeTruthy()
  expect(screen.getByText('Item 2')).toBeTruthy()
  expect(screen.getByRole('button', { expanded: true }).textContent).toBe('Needs you2')
})

it('says all clear only once no ask is left', () => {
  const { rerender } = render(<Section filter={NO_FILTER} asks={SIGN_IN} />)
  expect(screen.queryByText('Nothing needs you and nothing is running.')).toBeNull()

  const planned = makeTestBotItem(3, { status: 'planned', lastActivityAt: NOW })
  rerender(
    <Section filter={NO_FILTER} read={{ items: [planned], counts: {}, seenEventId: 'e0' }} />
  )
  expect(screen.getByText('Nothing needs you and nothing is running.')).toBeTruthy()
})
