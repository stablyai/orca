import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemBody } from './BotItemView'
import {
  getDefaultSettings,
  getDefaultVoiceSettings
} from '../../../../../shared/orca-profiles/constants'
import { botRefKey } from '@/lib/bot-hosts'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'

const item = makeTestBotItem(6, { title: 'Ship the share dialog' })
const comment = (id: string, text: string, at: number): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text },
  at
})
const start = Array.from({ length: 12 }, (_, index) =>
  comment(`e${String(index + 10)}`, `Comment ${index + 1}`, 1_700_000_000_000 + index * 60_000)
)

function Reader(): React.JSX.Element {
  const [events, setEvents] = useState(start)
  const addEarlier = (): void =>
    setEvents((shown) => [
      comment(`e0${shown.length}`, `Earlier comment ${shown.length}\n\nwith a second paragraph`, 1),
      ...shown
    ])
  return (
    <div className="flex h-[520px] flex-col">
      <button type="button" onClick={addEarlier}>
        Add earlier
      </button>
      <BotItemBody
        bot={fixtureCos}
        item={item}
        view={{
          item,
          events,
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

// A reader scrolled up while earlier activity lands above them.
export const reader = defineFixture({ width: 360, render: () => <Reader /> })

const defaults = getDefaultSettings('/home/fixture')

// Scrolled up from the end in the panel, with dictation on: the jump pill, the fade, and the mic.
export const scrolledUp = defineFixture({
  width: 360,
  store: { settings: { ...defaults, voice: { ...getDefaultVoiceSettings(), enabled: true } } },
  render: () => (
    <div className="bg-sidebar">
      <Reader />
    </div>
  ),
  interact: async (frame) => {
    const scroller = frame.querySelector<HTMLElement>('.overflow-y-auto')
    if (!scroller) {
      return
    }
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }))
    scroller.scrollTop = scroller.scrollHeight / 3
    scroller.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

const numbered = makeTestBotItem(35, {
  title: 'Show item numbers in lists',
  description: 'Bots say "item 35"; show that number on every row and in the item view.'
})

// The item's number before its title and in the line under it.
export const header = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-[600px] flex-col">
      <BotItemBody
        bot={fixtureCos}
        item={numbered}
        view={{
          item: numbered,
          events: start.slice(0, 1),
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
})

const snoozedItem = makeTestBotItem(36, {
  title: 'Rename Look around in settings copy',
  status: 'needs_you',
  question: { eventId: 'e36', text: 'Explore or Look for work?' },
  snoozedUntil: Date.now() + 40 * 60 * 60_000
})
const snoozedView = {
  item: snoozedItem,
  events: [
    {
      id: 'e40',
      kind: 'snoozed' as const,
      actor: { kind: 'owner' as const },
      data: { until: snoozedItem.snoozedUntil },
      at: Date.now() - 5 * 60_000
    }
  ],
  eventsRead: true,
  hasEarlier: false,
  failed: false,
  deleted: false,
  loadEarlier: () => {},
  retry: () => {}
}

function SnoozedItem(): React.JSX.Element {
  return (
    <div className="flex h-[360px] flex-col">
      <BotItemBody bot={fixtureCos} item={snoozedItem} view={snoozedView} />
    </div>
  )
}

// Snoozed: still Needs you, the wake time and Unsnooze under the status, and the snooze in Activity.
export const snoozed = defineFixture({ width: 360, render: () => <SnoozedItem /> })

// The status menu's Snooze submenu: presets with the time each resolves to, Pick a time…, Unsnooze.
export const snoozeMenu = defineFixture({
  width: 360,
  render: () => <SnoozedItem />,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('h2 + div button')?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 120))
    const sub = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
    sub?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    sub?.click()
    await new Promise((resolve) => setTimeout(resolve, 160))
  }
})

// No open question: its card would take the comment box's place.
const answering = makeTestBotItem(37, { title: 'Pick the share defaults' })
const answeringView = {
  ...snoozedView,
  item: answering,
  events: start.slice(0, 3)
}

// A short, narrow pane with a long answer and three images: the box gives way so Activity and Send stay.
export const shortPaneLongAnswer = defineFixture({
  width: 220,
  setup: () =>
    updateNativeChatComposerDraft(
      `bot-item-comment:${botRefKey(fixtureCos)}:${answering.uid}`,
      {
        text: Array.from(
          { length: 6 },
          (_, index) => `Part ${index + 1}: a full sentence of answer.`
        ).join('\n\n'),
        images: ['a', 'b', 'c'].map((id) => ({ id, path: `/home/me/.orca/attachments/${id}.png` }))
      },
      'immediate'
    ),
  render: () => (
    <div className="flex h-[414px] flex-col bg-sidebar">
      <BotItemBody bot={fixtureCos} item={answering} view={answeringView} />
    </div>
  )
})

const ASK = {
  context: [
    'Drafts for the launch post are ready, fact-checked against the last two weeks of releases.',
    '',
    '- **A: smoother day with your agents.** Leads with the worktree palette and the new item view; ends on "3 cleared".',
    '- **B: tiny friction.** Five small fixes in a row, one line each, no clip.',
    '- **C: juggling multiple agents.** The orchestration demo, with the side-by-side terminals.',
    '- The video is re-cut without the end card, 28 s.',
    '',
    'All three fit in one post with the clip. The 9 AM slot is held for tomorrow.'
  ].join('\n'),
  questions: [
    {
      prompt: 'Which draft goes out with the video tomorrow at 9 AM?',
      options: [
        { label: 'A: smoother day with your agents' },
        { label: 'B: tiny friction' },
        { label: 'C: juggling multiple agents' },
        { label: 'None, redraft' }
      ],
      recommended: 0
    }
  ]
}
const asking = makeTestBotItem(283, {
  title: 'Launch post: pick the draft',
  owner: { botId: fixtureCos.id, name: 'Launch helper' },
  status: 'needs_you',
  question: {
    eventId: 'e51',
    text: 'readable copy',
    gist: 'Drafts for the launch post are ready.',
    decisions: [
      {
        question: ASK.questions[0].prompt,
        replies: ASK.questions[0].options.map((option, index) => ({
          label: option.label,
          recommended: index === 0
        }))
      }
    ]
  }
})
const asker = { kind: 'bot' as const, botId: fixtureCos.id, chatId: 'chat-home' }
const askingView = {
  ...snoozedView,
  item: asking,
  events: [
    { id: 'e50', kind: 'made' as const, actor: asker, data: {}, at: Date.now() - 3 * 3_600_000 },
    {
      id: 'e51',
      kind: 'commented' as const,
      actor: asker,
      data: { text: 'readable copy', ask: ASK },
      at: Date.now() - 20 * 60_000
    },
    {
      id: 'e52',
      kind: 'status' as const,
      actor: asker,
      data: { from: 'working', to: 'needs_you' },
      at: Date.now() - 20 * 60_000
    }
  ]
}

// The agent's question waiting on the owner: its body folded, the Needs you footer and quick replies,
// and the one comment box naming it.
export const waitingQuestion = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-[680px] flex-col bg-sidebar">
      <BotItemBody bot={{ ...fixtureCos, name: 'Launch helper' }} item={asking} view={askingView} />
    </div>
  )
})

const answered = makeTestBotItem(283, {
  title: 'Launch post: pick the draft',
  owner: { botId: fixtureCos.id, name: 'Launch helper' },
  status: 'working'
})
const answeredView = {
  ...askingView,
  item: answered,
  events: [
    ...askingView.events,
    {
      id: 'e53',
      kind: 'commented' as const,
      actor: { kind: 'owner' as const },
      data: { text: 'A: smoother day with your agents', answers: 'e51' },
      at: Date.now() - 5 * 60_000
    },
    {
      id: 'e54',
      kind: 'status' as const,
      actor: { kind: 'owner' as const },
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: Date.now() - 5 * 60_000
    }
  ]
}

// After a quick reply: the line reads "Question → answer", muted, and the reply has no card of its own.
export const answeredQuestion = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-[680px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Launch helper' }}
        item={answered}
        view={answeredView}
      />
    </div>
  )
})

const waitSet = Date.now() - 50 * 60_000
const waitingItem = makeTestBotItem(214, {
  title: 'Polish the Items empty state',
  owner: { botId: fixtureCos.id, name: 'Designer' },
  status: 'waiting',
  wait: { text: 'Claude usage resets Nov 26, 9:00 AM; it continues on its own then', at: waitSet }
})
const waitingView = {
  ...snoozedView,
  item: waitingItem,
  events: [
    { id: 'e60', kind: 'made' as const, actor: asker, data: {}, at: waitSet - 3 * 3_600_000 },
    {
      id: 'e61',
      kind: 'commented' as const,
      actor: asker,
      data: {
        text: 'The new copy and spacing are on the branch; the dark screenshots aren’t done yet.'
      },
      at: waitSet - 60_000
    },
    {
      id: 'e62',
      kind: 'status' as const,
      actor: asker,
      data: { from: 'working', to: 'waiting', note: waitingItem.wait!.text },
      at: waitSet
    }
  ]
}

// Waiting: its move shows last as the Waiting on card, with no tag or buttons.
export const waitingOn = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-[520px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Designer' }}
        item={waitingItem}
        view={waitingView}
      />
    </div>
  )
})

// Waiting… on a Waiting item edits what it waits on; its card shows though its move isn't loaded.
export const waitingPick = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-[520px] flex-col bg-sidebar">
      <BotItemBody
        bot={{ ...fixtureCos, name: 'Designer' }}
        item={waitingItem}
        view={{ ...waitingView, events: waitingView.events.slice(0, 2) }}
      />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('h2 + div button')?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 160))
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((entry) => entry.textContent?.includes('Waiting'))
      ?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
