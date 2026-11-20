import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubBots } from '../../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import type { BotItemAsk } from '../../../../../shared/bots/bot-item-ask'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { BotItemBody } from './BotItemView'

const agent: Bot = {
  id: 'sample-helper',
  name: 'Build helper',
  hostId: 'local',
  folder: 'sample-helper',
  folderWorkspaceId: 'sample-workspace',
  agent: 'codex',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const actor = { kind: 'bot', botId: agent.id, chatId: 'sample-home' } as const
const at = Date.UTC(2026, 10, 18, 19, 40)
const ask: BotItemAsk = {
  context: 'The sample preview is ready for review.',
  questions: [
    {
      prompt: 'Where should the preview run?',
      options: [
        { label: 'Preview workspace', detail: 'Use a separate sample workspace.' },
        { label: 'Local workspace', detail: 'Use the workspace on this computer.' },
        { label: 'Hold for review', detail: 'Keep the current preview available.' }
      ],
      recommended: 0
    }
  ]
}
const prompt = ask.questions[0]!.prompt
const question: NonNullable<BotItem['question']> = {
  eventId: 'e2',
  text: prompt,
  answerable: true,
  ask
}
const open = makeTestBotItem(21, {
  owner: { botId: agent.id, name: agent.name },
  title: 'Review the sample preview',
  status: 'needs_you',
  question,
  createdAt: at,
  updatedAt: at,
  lastActivityAt: at
})
const events: BotItemEvent[] = [
  { id: 'e1', kind: 'made', actor, data: { status: 'working' }, at: at - 60_000 },
  { id: 'e2', kind: 'commented', actor, data: { text: prompt, answerable: true, ask }, at },
  { id: 'e3', kind: 'status', actor, data: { from: 'working', to: 'needs_you' }, at }
]

function ItemPage({
  item,
  activity
}: {
  item: BotItem
  activity: BotItemEvent[]
}): React.JSX.Element {
  return (
    <div className="@container flex h-[760px] flex-col bg-sidebar">
      <BotItemBody
        bot={agent}
        item={item}
        view={{
          item,
          events: activity,
          eventsRead: true,
          hasEarlier: false,
          failed: false,
          deleted: false,
          loadEarlier: () => {},
          retry: () => {}
        }}
      />
    </div>
  )
}

const setup = (): void => stubBots([agent])
export const options = defineFixture({
  width: 380,
  setup,
  render: () => <ItemPage item={open} activity={events} />
})

const longText = [
  '**Review the sample checklist**',
  '',
  'The preview includes the updated question card and answer history. Choose which details need a closer look before continuing.',
  '',
  '- Check the question and choices in the compact pane.',
  '- Review the answered state and earlier questions.',
  '- Confirm that long text wraps without sideways scrolling.',
  '- Read the preview notes: https://example.invalid/reviews/sample-item-page-with-a-long-descriptive-reference.',
  '- Compare the light and dark appearances.',
  '',
  'What would you like to review next?'
].join('\n')
const longItem: BotItem = { ...open, question: { eventId: 'e2', text: longText, answerable: true } }
export const longAsk = defineFixture({
  width: 380,
  setup,
  render: () => (
    <ItemPage
      item={longItem}
      activity={events.map((event) =>
        event.id === 'e2' ? { ...event, data: { text: longText, answerable: true } } : event
      )}
    />
  )
})

const olderEvents: BotItemEvent[] = [
  ...events.slice(0, 1),
  {
    id: 'e2',
    kind: 'commented',
    actor,
    data: { text: 'Should the preview include the earlier draft?', answerable: true },
    at: at - 30_000
  },
  { id: 'e3', kind: 'status', actor, data: { from: 'working', to: 'needs_you' }, at: at - 30_000 },
  { id: 'e4', kind: 'commented', actor, data: { text: prompt, answerable: true, ask }, at },
  { id: 'e5', kind: 'status', actor, data: { from: 'needs_you', to: 'needs_you' }, at }
]
export const olderAsks = defineFixture({
  width: 380,
  setup,
  render: () => (
    <ItemPage item={{ ...open, question: { ...question, eventId: 'e4' } }} activity={olderEvents} />
  )
})

const answeredItem: BotItem = { ...open, status: 'working', question: null }
const answeredEvents: BotItemEvent[] = [
  ...events,
  {
    id: 'e4',
    kind: 'commented',
    actor: { kind: 'owner' },
    data: { text: 'Preview workspace', decisions: [{ picks: [0] }], answers: 'e2' },
    at: at + 30_000
  },
  {
    id: 'e5',
    kind: 'status',
    actor: { kind: 'owner' },
    data: { from: 'needs_you', to: 'working' },
    at: at + 30_000
  }
]
export const answered = defineFixture({
  width: 380,
  setup,
  render: () => <ItemPage item={answeredItem} activity={answeredEvents} />
})

export const folded = defineFixture({
  width: 380,
  setup,
  render: () => <ItemPage item={open} activity={events} />,
  interact: async (frame) => {
    const collapse = frame.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')
    if (!collapse) {
      throw new Error('The open question has no collapse control')
    }
    collapse.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const input = Array.from(frame.querySelectorAll<HTMLElement>('[contenteditable="true"]')).find(
      (node) => node.checkVisibility()
    )
    if (!input) {
      throw new Error('The folded question has no active comment field')
    }
    input.focus()
  }
})

// A question asked where the page can't answer it in its own card (an older host): it stays in Activity,
// later notes follow it, and its Reply sends a comment.
const plainAsk =
  'The preview check is blocked. Options: (a) retry the check later; (b) name another reviewer; (c) stop here and review the first change alone. Reply a, b or c.'
const plainItem: BotItem = { ...open, question: { eventId: 'e2', text: plainAsk } }
const plainEvents: BotItemEvent[] = [
  events[0]!,
  { id: 'e2', kind: 'commented', actor, data: { text: plainAsk }, at },
  { id: 'e3', kind: 'status', actor, data: { from: 'working', to: 'needs_you' }, at },
  {
    id: 'e4',
    kind: 'commented',
    actor,
    data: { text: 'The first change passed its checks. Waiting on the choice above.' },
    at: at + 600_000
  }
]
export const plainAskReply = defineFixture({
  width: 380,
  setup,
  render: () => <ItemPage item={plainItem} activity={plainEvents} />
})

export const plainAskReplyOpen = defineFixture({
  width: 380,
  setup,
  render: () => <ItemPage item={plainItem} activity={plainEvents} />,
  interact: async (frame) => {
    const reply = Array.from(frame.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Reply'
    )
    if (!reply) {
      throw new Error('The open question has no Reply')
    }
    reply.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
})
