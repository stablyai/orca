// An agent's ask of several questions on the item page: one line at a time, picks held until the
// last line or "send anyway", and words typed in the comment box sent at once.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { botRefKey } from '@/lib/bot-hosts'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { BotItemBody } from './BotItemView'
import { botItemHeldAnswersScope } from './use-bot-item-question-steps'

const asker = { kind: 'bot' as const, botId: fixtureCos.id, chatId: 'chat-home' }

const SEVERAL = {
  context: [
    'Round 2 is open in your browser. It shows four places for the chat switcher, each switching in one click.',
    '',
    '- **P1, top strip (recommended):** a row of chats across the top of the workspace, each with its status dot. The selected chat’s own tabs sit underneath.',
    '- **P2, right panel:** a Chats tab in the right panel. The runner-up, but it only works when the panel is open on that tab.',
    '- **P3, left sidebar:** the chat rows under the agent.',
    '- **P4, chat rail:** a narrow vertical strip on the left edge of the workspace.'
  ].join('\n'),
  questions: [
    {
      prompt: 'Where should the chat switcher live?',
      options: [
        { label: 'P1 top strip' },
        { label: 'P2 right panel' },
        { label: 'P3 left sidebar' },
        { label: 'P4 chat rail' }
      ],
      recommended: 0
    },
    {
      prompt: 'With the top strip, does the left sidebar still list each agent’s chats?',
      options: [{ label: 'No, one row per agent' }, { label: 'Keep them as a second way in' }],
      recommended: 0
    },
    {
      prompt: 'Can you close a chat from its pill (× on hover, like a tab)?',
      options: [{ label: 'Yes, × on hover' }, { label: 'Only from the chat’s menu' }],
      recommended: 0
    },
    {
      prompt: 'Shortcut to switch chats?',
      options: [{ label: '⇧⌘1–9' }, { label: '^1–9 (today’s tab keys)' }],
      recommended: 0
    }
  ]
}
const severalItem = makeTestBotItem(231, {
  title: 'Per-chat layouts: where the chat switcher lives',
  owner: { botId: fixtureCos.id, name: 'Layouts helper' },
  status: 'needs_you',
  question: { eventId: 'e61', text: 'readable copy', gist: 'Round 2 is open in your browser.' }
})
const severalView = {
  eventsRead: true,
  hasEarlier: false,
  failed: false,
  deleted: false,
  loadEarlier: () => {},
  retry: () => {},
  item: severalItem,
  events: [
    { id: 'e60', kind: 'made' as const, actor: asker, data: {}, at: Date.now() - 3 * 3_600_000 },
    {
      id: 'e61',
      kind: 'commented' as const,
      actor: asker,
      data: { text: 'readable copy', ask: SEVERAL },
      at: Date.now() - 20 * 60_000
    },
    {
      id: 'e62',
      kind: 'status' as const,
      actor: asker,
      data: { from: 'working', to: 'needs_you' },
      at: Date.now() - 20 * 60_000
    }
  ]
}

// An ask of four questions, two picked: one line at a time, the picks held above until the last or
// "send anyway".
export const severalQuestions = defineFixture({
  width: 900,
  render: () => (
    <div className="flex h-[640px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Layouts helper' }}
        item={severalItem}
        view={severalView}
      />
    </div>
  ),
  interact: async (frame) => {
    for (const label of ['P1 top strip', 'No, one row per agent']) {
      const chip = [...frame.querySelectorAll('button')].find((button) =>
        // The recommended chip leads with its star.
        button.textContent?.replace('★', '').startsWith(label)
      )
      chip?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
})

const typedItem = makeTestBotItem(232, {
  ...severalItem,
  uid: 'fixture-several-typed'
})
const typedView = { ...severalView, item: typedItem }
const TYPED = 'Top strip, but ask a second opinion before landing it.'

// Words in the box, and no answers held from an earlier render of the same page: a reused fixture
// page keeps the draft store, so held picks would otherwise ride along on the send.
function typeInBox(uid: string): void {
  updateNativeChatComposerDraft(
    botItemHeldAnswersScope(fixtureCos, uid, 'e61'),
    { text: '' },
    'immediate'
  )
  updateNativeChatComposerDraft(
    `bot-item-comment:${botRefKey(fixtureCos)}:${uid}`,
    { text: TYPED },
    'immediate'
  )
}

async function sendFromBox(frame: HTMLElement): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  frame.querySelector<HTMLButtonElement>('button[aria-label="Comment"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 400))
}

// Words typed for the first of several questions, sent from the box: they post at once as one
// comment answering that line, instead of waiting on this device for the other lines. The fixture
// has no host, so the comment shows Not sent with Retry, and the line is open again.
export const severalQuestionsTypedAnswer = defineFixture({
  width: 900,
  setup: () => typeInBox(typedItem.uid),
  render: () => (
    <div className="flex h-[640px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Layouts helper' }}
        item={typedItem}
        view={typedView}
      />
    </div>
  ),
  interact: sendFromBox
})

const onItsWayItem = makeTestBotItem(233, {
  ...severalItem,
  uid: 'fixture-several-on-its-way'
})
const onItsWayView = { ...severalView, item: onItsWayItem }

// The same send while the host takes it: the ask stops asking, its answered line reads
// "Question → answer", and the box names no question until the host's read has the comment.
export const severalQuestionsTypedAnswerOnItsWay = defineFixture({
  width: 900,
  setup: () => {
    typeInBox(onItsWayItem.uid)
    const runtime: unknown = window.api.runtime
    Reflect.set(window.api, 'runtime', {
      ...(typeof runtime === 'object' ? runtime : {}),
      // The host is still taking the comment.
      call: () => new Promise(() => {})
    })
  },
  render: () => (
    <div className="flex h-[640px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Layouts helper' }}
        item={onItsWayItem}
        view={onItsWayView}
      />
    </div>
  ),
  interact: sendFromBox
})

const readItem = makeTestBotItem(234, {
  ...severalItem,
  uid: 'fixture-several-read',
  status: 'working'
})
const readView = {
  ...severalView,
  item: readItem,
  events: [
    ...severalView.events,
    {
      id: 'e63',
      kind: 'commented' as const,
      actor: { kind: 'owner' as const },
      data: { text: `Where should the chat switcher live? → ${TYPED}` },
      at: Date.now() - 60_000
    },
    {
      id: 'e64',
      kind: 'status' as const,
      actor: { kind: 'owner' as const },
      data: { from: 'needs_you', to: 'working' },
      at: Date.now() - 60_000
    }
  ]
}

// Once the host's read has it: the answered line reads "Question → answer" above, and the step is on
// the next open line, 1 of 3, which the box names.
export const severalQuestionsTypedAnswerRead = defineFixture({
  width: 900,
  render: () => (
    <div className="flex h-[640px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Layouts helper' }}
        item={readItem}
        view={readView}
      />
    </div>
  )
})
