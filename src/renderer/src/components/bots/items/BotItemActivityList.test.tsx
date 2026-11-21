// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { fixtureCos as BOT } from '../../../component-fixtures/fixture-bot-panel'
import { NativeChatFileLinkExistenceContext } from '../../native-chat/links/actions/native-chat-file-link-existence'
import { NativeChatLinkClickContext } from '../../native-chat/links/actions/native-chat-link-click-context'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { BotItemActivityList } from './BotItemActivityList'

const ASKER = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' } as const
const OWNER = { kind: 'owner' } as const

const ASKED: BotItemEvent[] = [
  {
    id: 'e2',
    kind: 'commented',
    actor: ASKER,
    data: { text: 'Retry it here?\n\nOr write it by hand.' },
    at: 200
  },
  { id: 'e3', kind: 'status', actor: ASKER, data: { from: 'working', to: 'needs_you' }, at: 200 }
]

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

it("opens a reply's file link and leads from its quote to the question", () => {
  const path = '/Users/x/orca-lanes/lead/report.md'
  const opened = vi.fn<CommentMarkdownLinkClickHandler>((event) => event.preventDefault())
  const existence = {
    watch: () => ({
      subscribe: () => () => {},
      getSnapshot: () => fileSnapshot
    }),
    recheck: () => {}
  }
  const fileSnapshot = {
    check: (link: { pathText: string }) => link.pathText === path,
    peek: () => false
  }
  const events: BotItemEvent[] = [
    ...ASKED,
    {
      id: 'e4',
      kind: 'commented',
      actor: OWNER,
      data: { text: `Retry with ${path} as input.`, answers: 'e2' },
      at: 250
    },
    {
      id: 'e5',
      kind: 'status',
      actor: OWNER,
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: 250
    }
  ]
  render(
    <NativeChatFileLinkExistenceContext value={existence}>
      <NativeChatLinkClickContext value={opened}>
        <BotItemActivityList bot={BOT} item={makeTestBotItem(6)} events={events} />
      </NativeChatLinkClickContext>
    </NativeChatFileLinkExistenceContext>
  )
  fireEvent.click(screen.getByRole('link', { name: path }))
  expect(opened).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    '#orca-native-chat-file=%2FUsers%2Fx%2Forca-lanes%2Flead%2Freport.md'
  )

  fireEvent.click(screen.getByRole('button', { name: /^Replying to: Retry it here\?/ }))
  expect(document.activeElement?.getAttribute('data-bot-item-comment-id')).toBe('e2')
})

it('renders linked references without their stored prefixes', () => {
  const events: BotItemEvent[] = [
    {
      id: 'e2',
      kind: 'linked',
      actor: ASKER,
      data: {
        links: [
          'url:https://example.invalid/reviews/a-long-reference?view=full',
          'file:/workspace/sample/notes.md'
        ]
      },
      at: 200
    }
  ]
  render(<BotItemActivityList bot={BOT} item={makeTestBotItem(6)} events={events} />)

  const row = screen.getByText(/linked/).closest('div')!
  expect(row.textContent).toContain(
    'linked https://example.invalid/reviews/a-long-reference?view=full, /workspace/sample/notes.md'
  )
  expect(row.textContent).not.toMatch(/url:|file:/)
})

const ASK = {
  context: 'The review is stuck until Monday.',
  questions: [
    {
      prompt: 'Go ahead without the design review?',
      options: [{ label: 'Go ahead' }, { label: 'Wait' }],
      recommended: 0
    }
  ]
}

const WAITING: BotItemEvent[] = [
  { id: 'e2', kind: 'commented', actor: ASKER, data: { text: 'readable copy', ask: ASK }, at: 200 },
  { id: 'e3', kind: 'status', actor: ASKER, data: { from: 'working', to: 'needs_you' }, at: 200 }
]

it("posts a quick reply as the owner's comment, and Alt-click puts it in the box instead", () => {
  const actions = { send: vi.fn(), edit: vi.fn(), recover: vi.fn(), type: vi.fn() }
  const item = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e2', text: 'readable copy' }
  })
  render(<BotItemActivityList bot={BOT} item={item} events={WAITING} quickReplies={actions} />)

  fireEvent.click(screen.getByRole('button', { name: /^Go ahead/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Wait' }), { altKey: true })
  fireEvent.click(screen.getByRole('button', { name: 'Type your answer' }))

  expect(actions.send).toHaveBeenCalledExactlyOnceWith('Go ahead')
  expect(actions.edit).toHaveBeenCalledExactlyOnceWith('Wait')
  expect(actions.type).toHaveBeenCalledOnce()
})

it('tags the comment that asks Needs you while the item waits on it, and only that one', () => {
  const item = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e2', text: 'readable copy' }
  })
  const events: BotItemEvent[] = [
    { id: 'e1', kind: 'commented', actor: ASKER, data: { text: 'Started on it.' }, at: 100 },
    ...WAITING
  ]
  render(
    <BotItemActivityList
      bot={BOT}
      item={item}
      events={events}
      quickReplies={{ send: vi.fn(), edit: vi.fn(), recover: vi.fn(), type: vi.fn() }}
    />
  )

  const [plain, asking] = screen.getAllByRole('article')
  expect(asking!.textContent).toContain('Needs you')
  expect(plain!.textContent).not.toContain('Needs you')
})

it('tags a question asked in prose Needs you too, while it is the item’s question', () => {
  const events: BotItemEvent[] = [
    {
      id: 'e2',
      kind: 'commented',
      actor: ASKER,
      data: { text: 'Hold mail while paused?' },
      at: 200
    },
    { id: 'e3', kind: 'status', actor: ASKER, data: { from: 'working', to: 'needs_you' }, at: 200 }
  ]
  const item = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e2', text: 'Hold mail while paused?' }
  })
  const { rerender } = render(<BotItemActivityList bot={BOT} item={item} events={events} />)

  expect(screen.getByRole('article').textContent).toContain('Needs you')

  rerender(<BotItemActivityList bot={BOT} item={makeTestBotItem(6)} events={events} />)
  expect(screen.getByRole('article').textContent).not.toContain('Needs you')
})

it('shows an answer an older host recorded as a quoted comment, the question reading Question → pick', () => {
  const events: BotItemEvent[] = [
    ...WAITING,
    {
      id: 'e4',
      kind: 'commented',
      actor: OWNER,
      data: { text: 'Wait', answers: 'e2', decisions: [{ picks: [1] }] },
      at: 250
    },
    {
      id: 'e5',
      kind: 'status',
      actor: OWNER,
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: 250
    }
  ]
  render(
    <BotItemActivityList
      bot={BOT}
      item={makeTestBotItem(6)}
      events={events}
      quickReplies={{ send: vi.fn(), edit: vi.fn(), recover: vi.fn(), type: vi.fn() }}
    />
  )

  expect(screen.queryByRole('button', { name: /^Go ahead/ })).toBeNull()
  expect(screen.queryByText('Needs you')).toBeNull()
  const question = document.querySelector('[data-bot-item-question="closed"]')!
  expect(question.textContent).toBe('Go ahead without the design review? → Wait')
  expect(
    screen.getByRole('button', { name: /^Replying to: Go ahead without the design review\?/ })
  ).toBeTruthy()
})

it("shows an agent's comment files as file buttons that open as file links, and folds images past six", () => {
  const store = '/Users/x/.orca/agent-session-attachments'
  const file = (n: number, name: string) =>
    `${store}/0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0${n}/${name}`
  const opened = vi.fn<CommentMarkdownLinkClickHandler>((event) => event.preventDefault())
  const images = Array.from({ length: 8 }, (_, n) => ({
    path: file(n, `shot-${n + 1}.png`),
    name: `shot-${n + 1}.png`,
    bytes: 3
  }))
  const events: BotItemEvent[] = [
    {
      id: 'e2',
      kind: 'commented',
      actor: ASKER,
      data: {
        text: `Full run.\n\n@${file(8, 'run.log')}\n@"${file(9, 'install report.html')}"`,
        images
      },
      at: 200
    }
  ]
  render(
    <NativeChatLinkClickContext value={opened}>
      <BotItemActivityList bot={BOT} item={makeTestBotItem(6)} events={events} />
    </NativeChatLinkClickContext>
  )

  const grid = document.querySelector('[data-bot-item-comment-images]')!
  expect(grid.textContent).toContain('shot-5.png')
  expect(grid.textContent).not.toContain('shot-6.png')
  expect(screen.getByRole('button', { name: '+3' })).toBeTruthy()
  expect(screen.getByText('Full run.')).toBeTruthy()
  expect(document.body.textContent).not.toContain('agent-session-attachments')

  fireEvent.click(screen.getByRole('link', { name: 'install report.html' }))
  expect(opened).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    `#orca-native-chat-file-path=${encodeURIComponent(file(9, 'install report.html'))}`
  )
  expect(screen.getByRole('link', { name: 'run.log' })).toBeTruthy()
})
