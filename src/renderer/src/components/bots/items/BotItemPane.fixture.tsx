import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem, BotItemEvent, BotItemLinkView } from '../../../../../shared/bots/bot-items'
import { BotItemPaneFrame } from './BotItemPane'
import { BotItemBody, BotItemDeletedNotice } from './BotItemView'
import { BotItemLoading } from './BotItemLoading'
import type { BotItemWalkState } from './use-bot-item-walk'
import { botRefKey } from '@/lib/bot-hosts'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'

const item = makeTestBotItem(6, {
  title: 'Ship the share dialog',
  description: 'Finish the share dialog from the design thread and open a PR.',
  status: 'working',
  doneMeans: 'PR is open with screenshots'
})
const events: BotItemEvent[] = [
  { id: 'e1', kind: 'commented', actor: { kind: 'owner' }, data: { text: 'Go with v2.' }, at: 1 }
]

function walk(index: number, total: number, fields: Partial<BotItemWalkState> = {}) {
  const state: BotItemWalkState = {
    uid: item.uid,
    place: { index, total },
    pending: false,
    failed: false,
    canStep: (direction) => (direction === 1 ? index < total : index > 1),
    open: () => {},
    step: () => {},
    retry: () => {},
    markGone: () => {},
    close: () => null,
    ...fields
  }
  return state
}

function Pane({
  state,
  shown = item,
  offline = false,
  deleted = false,
  activity = events,
  hasEarlier = false,
  tall = false,
  height
}: {
  state: BotItemWalkState
  shown?: BotItem
  offline?: boolean
  deleted?: boolean
  activity?: BotItemEvent[]
  hasEarlier?: boolean
  tall?: boolean
  height?: number
}): React.JSX.Element {
  return (
    <div
      className={tall ? 'flex h-[860px] flex-col' : 'flex h-[420px] flex-col'}
      style={height ? { height } : undefined}
    >
      <BotItemPaneFrame walk={state} offline={offline} onBack={() => {}}>
        {({ comment, statusSlot, nav }) => (
          <BotItemBody
            commentRef={comment}
            statusSlot={statusSlot}
            nav={nav}
            bot={fixtureCos}
            item={shown}
            deleted={deleted}
            notice={deleted ? <BotItemDeletedNotice /> : null}
            view={{
              item: shown,
              events: activity,
              eventsRead: true,
              hasEarlier,
              failed: false,
              deleted,
              loadEarlier: () => {},
              retry: () => {}
            }}
          />
        )}
      </BotItemPaneFrame>
    </div>
  )
}

export const middle = defineFixture({ width: 340, render: () => <Pane state={walk(3, 14)} /> })
export const first = defineFixture({ width: 340, render: () => <Pane state={walk(1, 14)} /> })
export const last = defineFixture({
  width: 340,
  render: () => <Pane state={walk(14, 14)} shown={{ ...item, status: 'done' }} />
})
export const only = defineFixture({ width: 340, render: () => <Pane state={walk(1, 1)} /> })
export const pageFailed = defineFixture({
  width: 340,
  render: () => <Pane state={walk(9, 14, { failed: true })} shown={{ ...item, status: 'done' }} />
})
export const deleted = defineFixture({
  width: 340,
  render: () => <Pane state={walk(3, 14)} deleted />
})
export const offline = defineFixture({
  width: 340,
  render: () => <Pane state={walk(3, 14)} offline />
})
export const narrowFourDigits = defineFixture({
  width: 260,
  render: () => <Pane state={walk(128, 1204)} />
})

const longTitle =
  'Keep the item title visible while reading a long activity thread in a narrow pane, including updates from every linked chat and the final review before shipping'
const longActivity: BotItemEvent[] = Array.from({ length: 12 }, (_, index) => ({
  id: `comment-${index}`,
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text: `Update ${index + 1}: The implementation is ready for review and verification.` },
  at: 1_700_000_000_000 + index * 60_000
}))
const prLink = (number: number, title: string): BotItemLinkView => ({
  kind: 'pr',
  ref: `acme/app#${number}`,
  pr: {
    shown: true,
    ref: `acme/app#${number}`,
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'open',
    checks: 'success',
    review: null,
    title,
    checkedAt: 1
  }
})
const workerLink = (ref: string, title: string, working: boolean): BotItemLinkView => ({
  kind: 'dispatch',
  ref,
  latest: null,
  title,
  state: working ? 'working' : 'completed',
  host: null,
  startedAt: 1_700_000_000_000,
  settledAt: working ? null : 1_700_000_600_000,
  report: null,
  pr: null
})
const twoLinks = [
  workerLink('ctx_c3', 'C3 CHANGES REQUIRED (2 P2) on 6b264e3e9cd', true),
  prLink(43345, 'feat(native-chat): show the usage-limit notice as one compact row')
]
const manyLinks: BotItemLinkView[] = [
  ...twoLinks,
  { kind: 'url', ref: 'https://github.com/acme/app/issues/41513' },
  { kind: 'url', ref: 'https://acme.slack.com/archives/C0123/p1794857462511729' },
  { kind: 'file', ref: 'designs/small-panel/worker-spec.md' },
  ...Array.from({ length: 9 }, (_, index) =>
    workerLink(`ctx_r${index}`, `Review round ${index + 1}`, false)
  )
]
const linked = { ...item, links: twoLinks }

/** Where the item's own scroll sits once the fixture shows. */
async function scrollItem(frame: HTMLElement, to: 'top' | 'bottom'): Promise<void> {
  const scroller = frame.querySelector<HTMLElement>('[role="region"]')!
  scroller.scrollTop = to === 'top' ? 0 : scroller.scrollHeight
  scroller.dispatchEvent(new Event('scroll'))
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

export const frozenTop = defineFixture({
  width: 340,
  render: () => <Pane state={walk(3, 14)} shown={linked} activity={longActivity} />,
  interact: (frame) => scrollItem(frame, 'top')
})
export const frozenScrolled = defineFixture({
  ...frozenTop,
  interact: (frame) => scrollItem(frame, 'bottom')
})
export const frozenWide = defineFixture({ ...frozenScrolled, width: 600 })
export const longTitleScrolled = defineFixture({
  ...frozenScrolled,
  render: () => (
    <Pane state={walk(3, 14)} shown={{ ...linked, title: longTitle }} activity={longActivity} />
  )
})
export const manyLinksTop = defineFixture({
  ...frozenTop,
  width: 480,
  render: () => (
    <Pane state={walk(3, 14)} shown={{ ...item, links: manyLinks }} activity={longActivity} />
  )
})
export const noLinksScrolled = defineFixture({
  ...frozenScrolled,
  render: () => <Pane state={walk(3, 14)} activity={longActivity} />
})
// A long title, many links and a long Done means in a short pane: the top caps and the Activity keeps room.
export const crowdedTopShort = defineFixture({
  ...frozenScrolled,
  render: () => (
    <Pane
      state={walk(3, 14)}
      height={360}
      shown={{
        ...item,
        title: longTitle,
        links: manyLinks,
        doneMeans: Array.from({ length: 6 }, () => item.doneMeans).join('; ')
      }}
      activity={longActivity}
    />
  )
})
export const crowdedTopTall = defineFixture({
  ...crowdedTopShort,
  render: () => (
    <Pane
      state={walk(3, 14)}
      tall
      shown={{
        ...item,
        title: longTitle,
        links: manyLinks,
        doneMeans: Array.from({ length: 6 }, () => item.doneMeans).join('; ')
      }}
      activity={longActivity}
    />
  )
})
export const loading = defineFixture({
  width: 340,
  render: () => (
    <div className="flex h-[420px] flex-col">
      <BotItemPaneFrame walk={walk(3, 14, { pending: true })} offline={false} onBack={() => {}}>
        {() => <BotItemLoading />}
      </BotItemPaneFrame>
    </div>
  )
})
export const keyboard = defineFixture({
  ...longTitleScrolled,
  render: () => (
    <Pane
      state={walk(3, 14)}
      shown={{ ...linked, title: longTitle }}
      activity={longActivity}
      hasEarlier
    />
  )
})

const AT = 1_700_000_000_000
const named = { ...item, owner: { ...item.owner, name: 'Builder' } }
const ASKER = { kind: 'bot', botId: fixtureCos.id, chatId: 'chat-home' } as const
const OWNER = { kind: 'owner' } as const
const QUESTION =
  'Should I retry the help-text build on this computer, or write the text by hand in the PR?\n\nRetrying needs your shell token for `pnpm gen:types`, about 4 minutes. By hand skips the build here; CI still runs it.'
const LOG = [
  'The help-text worker failed before it wrote anything. Its log ends at the CLI build:',
  '```\n$ pnpm build:cli\nsrc/cli/commands/post.ts:4:28\n  error TS2307: Cannot find module\n  ../generated/api-types\n ELIFECYCLE  Command failed with exit code 2.\n```',
  'The generated types come from `pnpm gen:types`, which needs the team token. The worker sandbox does not have it, so the build cannot finish there.',
  'Your shell has the token, so a retry here should get past this step.'
].join('\n\n')
const thread: BotItemEvent[] = [
  {
    id: 'e1',
    kind: 'commented',
    actor: OWNER,
    data: {
      text: "a few things for the help text while you're at it:\n\n- the example should use a real-looking handle, not `@someone`\n- `--to` takes an email or a user id, say both\n- mention the old limit is gone, people remember it from the old docs\n\nif the build fails, don't spend more than 10 min on it."
    },
    at: AT
  },
  { id: 'e2', kind: 'commented', actor: ASKER, data: { text: LOG }, at: AT + 60_000 },
  { id: 'e3', kind: 'commented', actor: ASKER, data: { text: QUESTION }, at: AT + 120_000 },
  {
    id: 'e4',
    kind: 'status',
    actor: ASKER,
    data: { from: 'working', to: 'needs_you' },
    at: AT + 120_000
  }
]
const answered: BotItemEvent[] = [
  ...thread,
  {
    id: 'e5',
    kind: 'commented',
    actor: OWNER,
    data: { text: 'retry here, cap it at 10 min', answers: 'e3' },
    at: AT + 300_000
  },
  {
    id: 'e6',
    kind: 'status',
    actor: OWNER,
    data: { from: 'needs_you', to: 'working', cause: 'answer' },
    at: AT + 300_000
  },
  {
    id: 'e7',
    kind: 'commented',
    actor: ASKER,
    data: { text: "Retrying here; I'll cap it at 10 minutes." },
    at: AT + 360_000
  }
]

/** The open question, tagged Needs you, under two long messages folded at 8 lines. */
export const asking = defineFixture({
  width: 400,
  render: () => (
    <Pane
      state={walk(3, 14)}
      shown={{ ...named, status: 'needs_you', question: { eventId: 'e3', text: QUESTION } }}
      activity={thread}
      tall
    />
  ),
  interact: (frame) => scrollItem(frame, 'bottom')
})
/** The answer, recorded: it quotes the question, which shows Answered; no move row. */
export const answeredQuestion = defineFixture({
  ...asking,
  render: () => <Pane state={walk(3, 14)} shown={named} activity={answered} tall />
})

const draftKey = (shown: BotItem): string =>
  `bot-item-comment:${botRefKey(fixtureCos)}:${shown.uid}`
const LONG_DRAFT = [
  'Retry here, and cap it at 10 minutes.',
  '',
  'If the build still fails:',
  '1. keep the log',
  '2. write the help text by hand in the PR',
  '3. leave the generated types for CI',
  '',
  "Then ping me with the PR link and I'll review it tonight."
].join('\n')

/** Answering the bot's question with a long draft: the arrows stay in the box's tool row. */
const drafting = {
  ...named,
  uid: 'uid-drafting',
  status: 'needs_you' as const,
  question: { eventId: 'e3', text: QUESTION }
}
export const askingLongDraft = defineFixture({
  ...asking,
  setup: () =>
    updateNativeChatComposerDraft(
      draftKey(drafting),
      { text: LONG_DRAFT, images: [] },
      'immediate'
    ),
  render: () => <Pane state={walk(3, 14)} shown={drafting} activity={thread} tall />
})

/** A 300px pane: a three-digit place still shows beside the arrows. */
export const narrow300 = defineFixture({
  width: 300,
  render: () => <Pane state={walk(42, 105)} />
})

async function focusArrow(frame: HTMLElement, wait: number): Promise<void> {
  frame.querySelector<HTMLButtonElement>('[data-bot-item-step="next"]')?.focus()
  await new Promise((resolve) => setTimeout(resolve, wait))
}

/** Keyboard focus on Next: its ring, inside the box. */
export const arrowFocused = defineFixture({
  width: 340,
  render: () => <Pane state={walk(3, 14)} />,
  interact: (frame) => focusArrow(frame, 50)
})

/** Next's tooltip, on hover: its label and chord. */
export const arrowTooltip = defineFixture({
  ...arrowFocused,
  interact: async (frame) => {
    const next = frame.querySelector<HTMLButtonElement>('[data-bot-item-step="next"]')
    next?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
})

/** A Closed page has been reading for a while: the counter's place shows a spinner, the arrows stay off. */
export const loadingNext = defineFixture({
  width: 340,
  render: () => <Pane state={walk(9, 14, { pending: true, canStep: () => false })} />,
  interact: () => new Promise((resolve) => setTimeout(resolve, 600))
})

/** A waiting question: the comment box stays, with the arrows in its row. */
const waiting = {
  ...named,
  uid: 'uid-card',
  status: 'needs_you' as const,
  question: { eventId: 'e3', text: QUESTION }
}
function askingAt(width: number) {
  return defineFixture({
    width,
    render: () => <Pane state={walk(3, 14)} shown={waiting} activity={thread} tall />,
    interact: (frame) => scrollItem(frame, 'bottom')
  })
}
export const asking300 = askingAt(300)
export const askingWide = askingAt(480)
/** A plain item at the same widths, to compare the arrows' x with a waiting question's. */
export const plain300 = defineFixture({
  width: 300,
  render: () => <Pane state={walk(3, 14)} activity={thread} tall />
})
export const plainWide = defineFixture({ ...plain300, width: 480 })
