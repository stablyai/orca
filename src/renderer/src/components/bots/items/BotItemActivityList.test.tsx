// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { fixtureCos as BOT } from '../../../component-fixtures/fixture-bot-panel'
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

function show(events: BotItemEvent[]): void {
  render(<BotItemActivityList bot={BOT} item={makeTestBotItem(6)} events={events} />)
}

it("leads a recorded answer's quote to its question, and the question's Answered back", () => {
  show([
    ...ASKED,
    { id: 'e4', kind: 'commented', actor: OWNER, data: { text: 'Retry.', answers: 'e2' }, at: 250 },
    {
      id: 'e5',
      kind: 'status',
      actor: OWNER,
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: 250
    }
  ])

  fireEvent.click(screen.getByRole('button', { name: /^Replying to: Retry it here\?/ }))
  expect(document.activeElement?.getAttribute('data-bot-item-comment-id')).toBe('e2')

  fireEvent.click(screen.getByRole('button', { name: /^Answered at .+\. Go to the answer$/ }))
  expect(document.activeElement?.getAttribute('data-bot-item-comment-id')).toBe('e4')
  expect(screen.queryByText(/moved this to/)).toBeNull()
})

it('shows an answer from before answers were recorded as before: no quote, Answered as text, the move kept', () => {
  show([
    ...ASKED,
    { id: 'e4', kind: 'commented', actor: OWNER, data: { text: 'Retry.' }, at: 250 },
    {
      id: 'e5',
      kind: 'status',
      actor: OWNER,
      data: { from: 'needs_you', to: 'working' },
      at: 250
    }
  ])

  expect(screen.getByText('Answered')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Go to the answer|Replying to/ })).toBeNull()
  expect(screen.getByText(/moved this to/)).toBeTruthy()
})
