// An agent's ask of several questions on the item page: every question on one card, answers picked or
// typed in the comment box held until Send posts them as one comment.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { botRefKey } from '@/lib/bot-hosts'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { BotItemBody } from './BotItemView'
import { botItemHeldAnswersScope } from './bot-item-held-answers'

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

// An ask of four questions, two picked: the picked lines fold, the rest stay open, and Send reads 2/4.
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

// An empty box, with `held` the answers held for other lines (none by default): a reused fixture
// page keeps the draft store, so earlier held answers would otherwise ride along.
function clearBox(uid: string, held = ''): void {
  updateNativeChatComposerDraft(
    botItemHeldAnswersScope(fixtureCos, uid, 'e61'),
    { text: held },
    'immediate'
  )
  updateNativeChatComposerDraft(
    `bot-item-comment:${botRefKey(fixtureCos)}:${uid}`,
    { text: '' },
    'immediate'
  )
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Words arriving in the open item's empty box take the line "Replying to" names; Enter holds them.
async function typeAndEnter(frame: HTMLElement, uid: string, held = ''): Promise<void> {
  // Again once open: drafts a theme's earlier run left are restored from storage after setup.
  clearBox(uid, held)
  await pause(250)
  updateNativeChatComposerDraft(
    `bot-item-comment:${botRefKey(fixtureCos)}:${uid}`,
    { text: TYPED },
    'immediate'
  )
  await pause(250)
  frame.querySelector<HTMLButtonElement>('button[aria-label="Comment"]')?.click()
  await pause(400)
}

// Words typed for the first of several questions, Enter in the box: held like a pick, the line folds
// to "✓ Question → answer", the box empties and names the next open line, and Send counts it.
// Nothing posts until Send.
export const severalQuestionsTypedAnswer = defineFixture({
  width: 900,
  setup: () => clearBox(typedItem.uid),
  render: () => (
    <div className="flex h-[640px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Layouts helper' }}
        item={typedItem}
        view={typedView}
      />
    </div>
  ),
  interact: (frame) => typeAndEnter(frame, typedItem.uid)
})

const reopenedItem = makeTestBotItem(235, { ...severalItem, uid: 'fixture-several-typed-reopened' })
const reopenedView = { ...severalView, item: reopenedItem }

// The held typed answer reopened: its words show as the pencil chip, which puts them back in the box.
export const severalQuestionsTypedAnswerReopened = defineFixture({
  width: 900,
  setup: () => clearBox(reopenedItem.uid),
  render: () => (
    <div className="flex h-[640px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Layouts helper' }}
        item={reopenedItem}
        view={reopenedView}
      />
    </div>
  ),
  interact: async (frame) => {
    await typeAndEnter(frame, reopenedItem.uid)
    frame
      .querySelector<HTMLButtonElement>('button[title^="Where should the chat switcher live? →"]')
      ?.click()
    await pause(250)
  }
})

// The other three lines' recommended answers, held.
const OTHERS_HELD = SEVERAL.questions
  .slice(1)
  .map(({ prompt, options }) => `${prompt} → ${options[0]!.label}`)
  .join('\n')

const onItsWayItem = makeTestBotItem(233, {
  ...severalItem,
  uid: 'fixture-several-on-its-way'
})
const onItsWayView = { ...severalView, item: onItsWayItem }

// Words typed for the first line, the other three held, then Send: all four post as one comment.
// While the host takes it the lines fold as sent and stay, and the box names no question.
export const severalQuestionsTypedAnswerOnItsWay = defineFixture({
  width: 900,
  setup: () => {
    clearBox(onItsWayItem.uid, OTHERS_HELD)
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
  interact: async (frame) => {
    await typeAndEnter(frame, onItsWayItem.uid, OTHERS_HELD)
    ;[...frame.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Send')
      ?.click()
    await pause(400)
  }
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

// One answer the host already has (a partial Send, or an older build): the answered line reads
// "Question → answer", and the box names the next open line.
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
