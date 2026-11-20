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

it("opens an answer's file link and navigates between its answer and question", () => {
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
        <BotItemActivityList bot={BOT} item={makeTestBotItem(6)} events={events} askShown={false} />
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

  fireEvent.click(screen.getByRole('button', { name: /^Answered at .+\. Go to the answer$/ }))
  expect(document.activeElement?.getAttribute('data-bot-item-comment-id')).toBe('e4')
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
  render(
    <BotItemActivityList bot={BOT} item={makeTestBotItem(6)} events={events} askShown={false} />
  )

  const row = screen.getByText(/linked/).closest('div')!
  expect(row.textContent).toContain(
    'linked https://example.invalid/reviews/a-long-reference?view=full, /workspace/sample/notes.md'
  )
  expect(row.textContent).not.toMatch(/url:|file:/)
})

it("replies to an open question the page can't answer in its own card, from the card itself", () => {
  const reply = vi.fn()
  const item = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e2', text: 'Retry it here?\n\nOr write it by hand.' }
  })
  render(
    <BotItemActivityList
      bot={BOT}
      item={item}
      events={ASKED}
      askShown={false}
      onReplyToQuestion={reply}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  const box = screen.getByRole('textbox', { name: 'Reply' })
  expect(document.activeElement).toBe(box)
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(reply).not.toHaveBeenCalled()

  fireEvent.change(box, { target: { value: '  b, by hand  ' } })
  fireEvent.keyDown(box, { key: 'Enter' })

  expect(reply).toHaveBeenCalledExactlyOnceWith('b, by hand')
  expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull()
})

it('offers no Reply where the card below takes the answer, or where the item takes no comment', () => {
  const item = makeTestBotItem(6, {
    status: 'needs_you',
    question: { eventId: 'e2', text: 'Retry it here?', answerable: true }
  })
  const view = render(
    <BotItemActivityList
      bot={BOT}
      item={item}
      events={ASKED}
      askShown
      onReplyToQuestion={vi.fn()}
    />
  )
  expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()

  view.rerender(<BotItemActivityList bot={BOT} item={item} events={ASKED} askShown={false} />)
  expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
})
