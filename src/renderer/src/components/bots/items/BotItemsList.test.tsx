// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

vi.mock('./use-bot-items', () => ({ setBotItemsStatus: vi.fn() }))

import { BotItemsList } from './BotItemsList'

const BOT: Bot = {
  id: 'bot-a',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
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
const NOW = Date.parse('2026-11-14T12:00:00Z')

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('returns focus to the row Back left, unfolding its group and showing past the first five', async () => {
  const planned = Array.from({ length: 8 }, (_, index) =>
    makeTestBotItem(index + 1, { status: 'planned', lastActivityAt: NOW - index })
  )
  render(
    <BotItemsList
      bot={BOT}
      groups={{ needs_you: [], working: [], planned, snoozed: [], stale: [], closed: [] }}
      seenEventId="e0"
      closedTotal={0}
      onMoreClosed={null}
      staleDays={null}
      now={NOW}
      focusUid="uid-7"
      onOpen={() => {}}
    />
  )
  await waitFor(() => expect(document.activeElement?.getAttribute('title')).toBe('Item 7'))
  expect(screen.getByRole('button', { name: /Planned/ }).getAttribute('aria-expanded')).toBe('true')
})

function renderClosed(): void {
  const closed = Array.from({ length: 8 }, (_, index) =>
    makeTestBotItem(index + 1, { status: 'done', lastActivityAt: NOW - index })
  )
  render(
    <BotItemsList
      bot={BOT}
      groups={{ needs_you: [], working: [], planned: [], snoozed: [], stale: [], closed }}
      seenEventId="e0"
      closedTotal={12}
      onMoreClosed={null}
      staleDays={null}
      now={NOW}
      onOpen={() => {}}
    />
  )
}

const closedRows = (): (string | null)[] =>
  [...document.querySelectorAll('[data-bot-item]')].map((row) => row.getAttribute('data-bot-item'))

it('shows Closed open with paging, then keeps the owner’s fold across remounts', () => {
  // Closed's flag from when it was folded by default meant the owner opened it.
  localStorage.setItem('orca.bots.panelFolds', JSON.stringify({ 'bot-a': ['items-closed'] }))
  renderClosed()
  expect(screen.getByRole('button', { name: /Closed/ }).getAttribute('aria-expanded')).toBe('true')
  expect(closedRows()).toEqual(['1', '2', '3', '4', '5'])
  expect(screen.getByRole('button', { name: 'Show 7 more' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /Closed/ }))
  cleanup()
  renderClosed()
  expect(screen.getByRole('button', { name: /Closed/ }).getAttribute('aria-expanded')).toBe('false')
  expect(closedRows()).toEqual([])
})
