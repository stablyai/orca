// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

vi.mock('../BotGroupTranscriptOwner', () => ({ useBotGroupFileContexts: () => new Map() }))

const { BotItemHeader } = await import('./BotItemHeader')

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

const pr = (number: number, title: string): BotItemLinkView => ({
  kind: 'pr',
  ref: `acme/app#${number}`,
  pr: {
    shown: true,
    ref: `acme/app#${number}`,
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'open',
    checks: null,
    review: null,
    title,
    checkedAt: 1
  }
})
const LINKS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pr(n, `Change ${n}`))

// happy-dom lays nothing out: chips sit three to a 24px line, the list shows `lines` of them.
const CHIPS_PER_LINE = 3
let lines = 2
let observers: (() => void)[] = []
const resize = (): void => observers.forEach((callback) => callback())
beforeEach(() => {
  lines = 2
  observers = []
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.tagName !== 'LI' || !this.parentElement) {
      return 0
    }
    const index = Array.from(this.parentElement.children).indexOf(this)
    return Math.floor(index / CHIPS_PER_LINE) * 28
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.tagName === 'UL' ? lines * 28 - 4 : 0
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observers.push(callback)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderHeader(links: BotItemLinkView[]): void {
  const item = makeTestBotItem(264, { title: 'Usage-limit chat card', links })
  render(
    <TooltipProvider>
      <BotItemHeader
        bot={BOT}
        item={item}
        chatTitle="Fix This"
        deleted={false}
        onStatus={() => {}}
        snoozing={{ snooze: () => {}, pick: () => {}, dialog: null }}
        scrollRef={{ current: document.createElement('div') }}
      />
    </TooltipProvider>
  )
}

const worker = (ref: string, title: string, state: 'working' | 'completed'): BotItemLinkView => ({
  kind: 'dispatch',
  ref,
  latest: null,
  title,
  state,
  host: null,
  startedAt: 1,
  settledAt: state === 'working' ? null : 2,
  report: null,
  pr: null
})

it('draws no links row for an item without links', () => {
  renderHeader([])
  expect(screen.queryByRole('list', { name: 'Links' })).toBeNull()
  expect(screen.queryByRole('button', { name: /more links/ })).toBeNull()
})

it('puts the links two lines have no room for behind +N, which lists them', async () => {
  renderHeader(LINKS)
  const more = screen.getByRole('button', { name: '2 more links' })
  fireEvent.pointerDown(more, { button: 0, ctrlKey: false })
  fireEvent.click(more)
  const popover = await screen.findByRole('dialog')
  expect(within(popover).getAllByRole('button')).toHaveLength(2)
  expect(within(popover).getByRole('button', { name: /Change 7/ })).toBeTruthy()
  expect(within(popover).getByRole('button', { name: /Change 8/ })).toBeTruthy()
  const shown = within(screen.getByRole('list', { name: 'Links' }))
  expect(shown.queryByRole('button', { name: /Change 7/ })).toBeNull()
})

it('counts again when the row changes size, as a short window leaves it one line', () => {
  renderHeader(LINKS)
  expect(screen.getByRole('button', { name: '2 more links' })).toBeTruthy()
  lines = 1
  act(() => resize())
  expect(screen.getByRole('button', { name: '5 more links' })).toBeTruthy()
  lines = 3
  act(() => resize())
  expect(screen.queryByRole('button', { name: /more links/ })).toBeNull()
})

it('keeps live workers and PRs in view ahead of workers that have finished', () => {
  renderHeader([
    worker('d1', 'Old review', 'completed'),
    worker('d2', 'Fixing the card', 'working'),
    pr(43345, 'One compact row')
  ])
  const chips = within(screen.getByRole('list', { name: 'Links' })).getAllByRole('button')
  expect(chips.map((chip) => chip.getAttribute('aria-label') ?? chip.textContent)).toEqual([
    'Fixing the card',
    'Stop Fixing the card',
    'One compact row#43345',
    'Old review'
  ])
})
