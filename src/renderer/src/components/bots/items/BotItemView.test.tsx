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
const statusSet = vi.hoisted(() => vi.fn())
vi.mock('./use-bot-items', () => ({
  commentOnBotItem: sent,
  setBotItemsStatus: statusSet
}))
const fileContextOwners = vi.hoisted(() => vi.fn((..._args: unknown[]) => new Map()))
vi.mock('../BotGroupTranscriptOwner', () => ({ useBotGroupFileContexts: fileContextOwners }))
const openAppHttpLink = vi.hoisted(() => vi.fn())
vi.mock(import('@/lib/browser/navigation/app-http-link-open'), async (importOriginal) => ({
  ...(await importOriginal()),
  openAppHttpLink
}))
vi.mock('./BotItemActivityList', () => ({
  BotItemActivityList: ({
    events,
    quickReplies
  }: {
    events: BotItemEvent[]
    quickReplies?: {
      send: (text: string) => void
      edit: (text: string) => void
      steps?: { current: number; answer: (index: number, words: string) => void } | null
    }
  }) => (
    <ol>
      {events.map((event) => (
        <li key={event.id}>{event.id}</li>
      ))}
      {quickReplies ? (
        <>
          <button type="button" onClick={() => quickReplies.send('Go ahead')}>
            Quick reply
          </button>
          <button type="button" onClick={() => quickReplies.edit('Go ahead')}>
            Edit quick reply
          </button>
          {quickReplies.steps ? (
            <button
              type="button"
              onClick={() => quickReplies.steps?.answer(quickReplies.steps.current, 'Yes')}
            >
              Answer this step
            </button>
          ) : null}
        </>
      ) : null}
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
    eventsRead: true,
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
  sent.mockReset()
  statusSet.mockReset()
  openAppHttpLink.mockClear()
  fileContextOwners.mockReturnValue(new Map())
})

it('follows new events until the reader scrolls up, then offers Jump to latest', () => {
  show(3)
  const view = render(<BotItemView bot={BOT} uid="uid-6" />)
  expect(scroller().scrollTop).toBe(CONTENT)

  scroller().scrollTop = 0
  show(4)
  view.rerender(<BotItemView bot={BOT} uid="uid-6" />)
  expect(scroller().scrollTop).toBe(CONTENT)
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

  expect(sent).toHaveBeenCalledWith(BOT, 'uid-6', 'Ship it', [], expect.any(String), undefined)
  expect(scroller().scrollTop).toBe(CONTENT)
})

it('focuses the comment box from its card and preserves focus outside it when submitting', async () => {
  show(3, makeTestBotItem(6, { question: { eventId: 'e3', text: 'Which flow?' } }))
  render(<BotItemView bot={BOT} uid="uid-6" />)

  fireEvent.click(document.querySelector('[data-native-chat-composer-scope]')!)

  const box = screen.getByRole('textbox', { name: 'Comment' })
  expect(document.activeElement).toBe(box)
  changePrompt(box, 'Use the proposed flow')
  box.blur()
  expect(box.contains(document.activeElement)).toBe(false)

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })))

  expect(sent).toHaveBeenCalledExactlyOnceWith(
    BOT,
    'uid-6',
    'Use the proposed flow',
    [],
    expect.any(String),
    undefined
  )
  expect(box.contains(document.activeElement)).toBe(false)
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

const WAITING = makeTestBotItem(6, {
  status: 'needs_you',
  question: { eventId: 'e3', text: 'Which flow should ship?' }
})

it("keeps the comment box while the question waits, and posts a quick reply as the owner's comment", async () => {
  show(3, WAITING)
  render(<BotItemView bot={BOT} uid="uid-6" />)

  expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Quick reply' })))

  expect(sent).toHaveBeenCalledExactlyOnceWith(
    BOT,
    'uid-6',
    'Go ahead',
    [],
    expect.any(String),
    undefined
  )
  expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy()
})

it('holds the answers to an ask of several questions and posts them as one comment at the last', async () => {
  const ask = {
    questions: [
      { prompt: 'Ship it?', options: [{ label: 'Yes' }] },
      { prompt: 'Tell the team?', options: [{ label: 'Yes' }] }
    ]
  }
  const asker = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' } as const
  read.current = {
    item: makeTestBotItem(6, { status: 'needs_you', question: { eventId: 'e1', text: 'copy' } }),
    events: [
      { id: 'e1', kind: 'commented', actor: asker, data: { text: 'copy', ask }, at: 1 },
      { id: 'e2', kind: 'status', actor: asker, data: { from: 'working', to: 'needs_you' }, at: 1 }
    ],
    eventsRead: true,
    hasEarlier: false,
    failed: false,
    deleted: false,
    loadEarlier: vi.fn(),
    retry: vi.fn()
  }
  render(<BotItemView bot={BOT} uid="uid-6" />)

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Answer this step' })))
  expect(sent).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Answer this step' })))

  expect(sent).toHaveBeenCalledExactlyOnceWith(
    BOT,
    'uid-6',
    'Ship it? → Yes\nTell the team? → Yes',
    [],
    expect.any(String),
    'e1'
  )
})

it("puts a quick reply's words in the comment box to add to, without sending", () => {
  show(3, WAITING)
  render(<BotItemView bot={BOT} uid="uid-6" />)

  fireEvent.click(screen.getByRole('button', { name: 'Edit quick reply' }))

  const box = screen.getByRole('textbox', { name: 'Comment' })
  expect(box.textContent).toBe('Go ahead ')
  expect(document.activeElement).toBe(box)
  expect(sent).not.toHaveBeenCalled()
})

it('keeps focus in the item, with its arrows, when it is deleted while its comment box has focus', () => {
  const nothingFocused = (): boolean =>
    document.activeElement === null || document.activeElement === document.body
  const nav = <button type="button">Next item</button>
  show(3)
  const view = render(<BotItemView bot={BOT} uid="uid-6" takeFocus={nothingFocused} nav={nav} />)
  const box = screen.getByRole('textbox', { name: 'Comment' })
  box.focus()
  expect(document.activeElement).toBe(box)

  read.current = { ...read.current!, deleted: true }
  view.rerender(<BotItemView bot={BOT} uid="uid-6" takeFocus={nothingFocused} nav={nav} />)
  expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
  expect(document.activeElement).toBe(document.querySelector('[data-bot-item-focus-home]'))
  expect(screen.getByRole('button', { name: 'Next item' })).toBeTruthy()
})

it('reads earlier pages until the waiting question shows, so its words and quick replies are there', () => {
  show(
    3,
    makeTestBotItem(6, { status: 'needs_you', question: { eventId: 'e0', text: 'Ship it?' } })
  )
  read.current = { ...read.current!, hasEarlier: true }
  render(<BotItemView bot={BOT} uid="uid-6" />)

  expect(read.current.loadEarlier).toHaveBeenCalledOnce()
})
