// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemViewRead } from './use-bot-item-view'

const read = vi.hoisted((): { current: BotItemViewRead | null } => ({ current: null }))
const sent = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('./use-bot-item-view', () => ({ useBotItemView: () => read.current }))
vi.mock('./use-bot-items', () => ({ commentOnBotItem: sent, setBotItemsStatus: vi.fn() }))
const fileContextOwners = vi.hoisted(() => vi.fn((..._args: unknown[]) => new Map()))
vi.mock('../BotGroupTranscriptOwner', () => ({ useBotGroupFileContexts: fileContextOwners }))
const openAppHttpLink = vi.hoisted(() => vi.fn())
vi.mock(import('@/lib/browser/navigation/app-http-link-open'), async (importOriginal) => ({
  ...(await importOriginal()),
  openAppHttpLink
}))
vi.mock('./BotItemActivityList', () => ({
  BotItemActivityList: ({ events }: { events: BotItemEvent[] }) => (
    <ol>
      {events.map((event) => (
        <li key={event.id}>{event.id}</li>
      ))}
    </ol>
  )
}))

import { BotItemView } from './BotItemView'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { changePrompt } from '../../native-chat/composer/editor/native-chat-prompt-editor.test-support'

// The app root provides tooltips; the mic's needs it here too.
const render = (ui: React.ReactElement) => renderBare(ui, { wrapper: TooltipProvider })

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
const VIEWPORT = 200
const CONTENT = 1000

function eventsUpTo(count: number): BotItemEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${index + 1}`,
    kind: 'commented',
    actor: { kind: 'owner' },
    data: {},
    at: index
  }))
}

function show(count: number, item = makeTestBotItem(6)): void {
  read.current = {
    item,
    events: eventsUpTo(count),
    hasEarlier: false,
    failed: false,
    deleted: false,
    loadEarlier: vi.fn(),
    retry: vi.fn()
  }
}

function scroller(): HTMLElement {
  const node = screen.getByText('e1').closest<HTMLElement>('.overflow-y-auto')
  if (!node) {
    throw new Error('no scroller')
  }
  return node
}

function readerScrollsToTop(): void {
  const node = scroller()
  fireEvent.wheel(node, { deltaY: -400 })
  node.scrollTop = 0
  fireEvent.scroll(node)
}

const pill = (): HTMLElement => screen.getByText('Jump to latest').closest('button')!

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(CONTENT)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sent.mockClear()
  openAppHttpLink.mockClear()
  fileContextOwners.mockReturnValue(new Map())
})

it('opens at the newest event and stays there as events arrive', () => {
  show(3)
  const view = render(<BotItemView bot={BOT} uid="uid-6" />)
  expect(scroller().scrollTop).toBe(CONTENT)

  scroller().scrollTop = 0
  show(4)
  view.rerender(<BotItemView bot={BOT} uid="uid-6" />)

  expect(scroller().scrollTop).toBe(CONTENT)
  expect(pill().dataset.shown).toBe('false')
})

it('shows Jump to latest once scrolled up from the end, and jumps there when clicked', () => {
  show(3)
  const view = render(<BotItemView bot={BOT} uid="uid-6" />)
  expect(pill().dataset.shown).toBe('false')

  readerScrollsToTop()
  expect(pill().dataset.shown).toBe('true')

  show(5)
  view.rerender(<BotItemView bot={BOT} uid="uid-6" />)
  expect(scroller().scrollTop).toBe(0)

  fireEvent.click(pill())

  expect(scroller().scrollTop).toBe(CONTENT)
  expect(pill().dataset.shown).toBe('false')
})

it('scrolls to the end after a comment is sent', async () => {
  show(3)
  render(<BotItemView bot={BOT} uid="uid-6" />)
  readerScrollsToTop()
  const box = screen.getByRole('textbox', { name: 'Comment' })
  changePrompt(box, 'Ship it')

  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
  })

  expect(sent).toHaveBeenCalledWith(BOT, 'uid-6', 'Ship it', [])
  expect(scroller().scrollTop).toBe(CONTENT)
})

it('focuses the comment box when its card is clicked inside the focusable item pane', () => {
  show(3, makeTestBotItem(6, { question: { eventId: 'e3', text: 'Which flow?' } }))
  render(<BotItemView bot={BOT} uid="uid-6" />)

  fireEvent.click(screen.getByText('Which flow?'))

  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Comment' }))
})

it('places its file opens beside the bot workspace focused tab, as a click in that chat would', () => {
  const initial = useAppStore.getState()
  useAppStore.setState({
    groupsByWorktree: {
      'folder:w1': [
        makeTabGroup({ id: 'g-left', worktreeId: 'folder:w1', activeTabId: 'other' }),
        makeTabGroup({ id: 'g-chat', worktreeId: 'folder:w1', activeTabId: 'chat-tab' })
      ]
    },
    activeGroupIdByWorktree: { 'folder:w1': 'g-chat' },
    unifiedTabsByWorktree: {
      'folder:w1': [
        makeUnifiedTab({ id: 'other', worktreeId: 'folder:w1', groupId: 'g-left' }),
        makeUnifiedTab({ id: 'chat-tab', worktreeId: 'folder:w1', groupId: 'g-chat' })
      ]
    }
  })
  try {
    show(1)
    render(<BotItemView bot={BOT} uid="uid-6" />)

    expect(fileContextOwners).toHaveBeenLastCalledWith([], BOT, 'chat-tab')
  } finally {
    useAppStore.setState(initial, true)
  }
})

const PR_URL = 'https://github.com/acme/app/pull/9'

function showPrLink(): void {
  const context = {
    worktreeId: 'folder:w1',
    worktreePath: '/bots/bot-builder',
    runtimeEnvironmentId: null
  }
  fileContextOwners.mockReturnValue(
    new Map([
      [
        BOT.id,
        { fileLinkContext: context, runtimeContext: { target: { kind: 'local' }, ...context } }
      ]
    ])
  )
  show(1, { ...makeTestBotItem(6), links: [{ kind: 'url', ref: PR_URL }] })
  render(<BotItemView bot={BOT} uid="uid-6" />)
}

it('opens a PR link in the workspace card’s link popover', () => {
  showPrLink()
  fireEvent.click(screen.getByRole('button', { name: /#9/ }))

  const popover = document.querySelector<HTMLElement>('[data-link-action-popover]')!
  expect(within(popover).getByText(PR_URL)).toBeTruthy()
  expect(within(popover).getByRole('button', { name: 'Copy link' })).toBeTruthy()
  expect(within(popover).getByText('System Browser')).toBeTruthy()
  expect(openAppHttpLink).not.toHaveBeenCalled()
})

it('sends a plain click the link setting leaves alone to the system browser, as the workspace card does', () => {
  const initial = useAppStore.getState()
  useAppStore.setState({ settings: { ...initial.settings!, terminalLinkClickBehavior: 'none' } })
  try {
    showPrLink()
    fireEvent.click(screen.getByRole('button', { name: /#9/ }))

    expect(document.querySelector('[data-link-action-popover]')).toBeNull()
    expect(openAppHttpLink).toHaveBeenCalledWith(
      PR_URL,
      expect.objectContaining({ destination: 'system' })
    )
  } finally {
    useAppStore.setState(initial, true)
  }
})
