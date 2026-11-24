// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { botItemHeldAnswersText } from '../../../../../shared/bots/bot-item-answer-lines'
import { botItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import { writeNativeChatDraftCache } from '../../native-chat/drafts/native-chat-draft-views'
import { BotItemActivityList } from './BotItemActivityList'
import { botItemHeldAnswersScope } from './bot-item-held-answers'

// A body's height follows its text: a question's long context overflows its 8-line cut, a reply does not.
const sizes = ['scrollHeight', 'clientHeight'] as const
const saved = sizes.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key))
function tall(node: HTMLElement): number {
  return (node.textContent?.length ?? 0) > 100 ? 400 : 20
}
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return tall(this)
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return Math.min(tall(this), 152)
    }
  })
})
afterAll(() => {
  sizes.forEach((key, index) => {
    const descriptor = saved[index]
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, key, descriptor)
    }
  })
})
afterEach(cleanup)

const ask = (id: string, at: number): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: { kind: 'bot', botId: fixtureCos.id, chatId: 'chat-home' },
  data: { text: `Question ${id}?\n${'Context line.\n'.repeat(20)}` },
  at
})
const reply = (id: string, to: string, at: number): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text: `Answer to ${to}`, answers: to },
  at
})
const asking = (eventId: string | null): BotItem =>
  makeTestBotItem(1, {
    status: eventId ? 'waiting' : 'working',
    question: eventId ? { eventId, text: `Question ${eventId}?` } : null
  })

function Activity({ item, events }: { item: BotItem; events: BotItemEvent[] }): React.JSX.Element {
  return (
    <TooltipProvider>
      <BotItemActivityList bot={fixtureCos} item={item} events={events} />
    </TooltipProvider>
  )
}

const toggle = (name: string): HTMLElement[] => screen.queryAllByRole('button', { name })

it('keeps an answered question whole until the item is opened again', () => {
  const first = ask('q1', 1)
  const second = ask('q2', 3)
  const { rerender, unmount } = render(<Activity item={asking('q1')} events={[first]} />)
  // Open: whole, with no fold to offer.
  expect(toggle('Show more')).toHaveLength(0)
  expect(toggle('Show less')).toHaveLength(0)

  // Answered (here or on another device) while shown: still whole, foldable.
  const answered = [first, reply('r1', 'q1', 2)]
  rerender(<Activity item={asking(null)} events={answered} />)
  expect(toggle('Show less')).toHaveLength(1)
  expect(toggle('Show more')).toHaveLength(0)

  // The next question opens whole; once answered, both stay whole.
  rerender(<Activity item={asking('q2')} events={[...answered, second]} />)
  expect(toggle('Show less')).toHaveLength(1)
  const all = [...answered, second, reply('r2', 'q2', 4)]
  rerender(<Activity item={asking(null)} events={all} />)
  expect(toggle('Show less')).toHaveLength(2)

  // Show less still folds one.
  fireEvent.click(toggle('Show less')[0]!)
  expect(toggle('Show more')).toHaveLength(1)
  expect(toggle('Show less')).toHaveLength(1)

  // Opened again: folded like any older comment.
  unmount()
  render(<Activity item={asking(null)} events={all} />)
  expect(toggle('Show more')).toHaveLength(2)
  expect(toggle('Show less')).toHaveLength(0)
})

const askOf = (id: string, prompts: string[], at: number): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: { kind: 'bot', botId: fixtureCos.id, chatId: 'chat-home' },
  data: {
    text: id,
    ask: {
      questions: prompts.map((prompt) => ({ prompt, options: [{ label: 'Yes' }, { label: 'No' }] }))
    }
  },
  at
})
const NO_ACTIONS = { send: () => {}, edit: () => {}, recover: () => {}, type: () => {} }
const replacedLabel = (): HTMLElement[] =>
  screen.queryAllByRole('button', { name: 'Replaced by a newer question' })

it('a replaced ask with answers held on it still reads replaced, and leads to the waiting ask', () => {
  Element.prototype.scrollIntoView ??= () => {}
  const old = askOf('q1', ['Which region?', 'Keep the old index?'], 1)
  const live = askOf('q2', ['Roll out everywhere?'], 2)
  const shape = botItemQuestionShape(old.data)
  writeNativeChatDraftCache(
    botItemHeldAnswersScope(fixtureCos, 'uid-1', 'q1'),
    botItemHeldAnswersText(shape, ['Yes', 'No'])
  )
  const item = makeTestBotItem(1, {
    status: 'needs_you',
    question: { eventId: 'q2', text: 'Roll out everywhere?' }
  })
  render(
    <TooltipProvider>
      <BotItemActivityList
        bot={fixtureCos}
        item={item}
        events={[old, live]}
        quickReplies={NO_ACTIONS}
      />
    </TooltipProvider>
  )
  // The held answers still show, to recover, under the replaced label.
  expect(screen.getAllByText(/not sent yet/)).toHaveLength(2)
  expect(replacedLabel()).toHaveLength(1)
  fireEvent.click(replacedLabel()[0]!)
  expect(document.activeElement?.getAttribute('data-bot-item-comment-id')).toBe('q2')
})

it('a replaced ask leads nowhere once no ask waits, even with a Needs you move in the Activity', () => {
  const old = askOf('q1', ['Which region?', 'Keep the old index?'], 1)
  const live = askOf('q2', ['Roll out everywhere?'], 2)
  const moved: BotItemEvent = {
    id: 's1',
    kind: 'status',
    actor: { kind: 'bot', botId: fixtureCos.id, chatId: 'chat-home' },
    data: { from: 'working', to: 'needs_you' },
    at: 4
  }
  const events = [old, live, reply('r2', 'q2', 3), moved]
  render(
    <Activity item={makeTestBotItem(1, { status: 'needs_you', question: null })} events={events} />
  )
  expect(screen.getByText('Replaced by a newer question')).toBeTruthy()
  expect(replacedLabel()).toHaveLength(0)
})
