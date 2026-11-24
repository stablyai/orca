import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useCallback, useEffect, useState } from 'react'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem, BotItemEvent, BotItemLinkView } from '../../../../../shared/bots/bot-items'
import type { Bot } from '../../../../../shared/bot-types'
import { BotItemBody } from './BotItemView'
import type { BotItemViewRead } from './use-bot-item-view'

const bot: Bot = { ...fixtureCos, name: 'Release bot' }
const min = 60_000
const now = Date.now()
const BOT_ACTOR = { kind: 'bot' as const, botId: bot.id, chatId: 'chat-home' }
const OWNER = { kind: 'owner' as const }
const ASK = 'Pick the share default: view-only links, or editable for the team?'

const status = (id: string, from: string, to: string, at: number, note?: string): BotItemEvent => ({
  id,
  kind: 'status',
  actor: BOT_ACTOR,
  data: { from, to, ...(note ? { note } : {}) },
  at
})
const comment = (id: string, text: string, at: number, owner = false): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: owner ? OWNER : BOT_ACTOR,
  data: { text },
  at
})
const LINES = [
  'Built the dialog to the mock and opened the PR.',
  'Checks are green on the new head; the snapshot test was flaky and is fixed.',
  'The copy pass is in. Two strings were too long for the narrow pane.',
  'Reran the share flow by hand on a fresh profile. Nothing new.'
]

/** A long Activity: the move that asked sits in the middle, with entries before and after it. */
function activity(asked: 'note' | 'question' | null): BotItemEvent[] {
  const start = now - 300 * min
  const events: BotItemEvent[] = [
    { id: 'e1', kind: 'made', actor: BOT_ACTOR, data: { status: 'working' }, at: start }
  ]
  for (let index = 0; index < 8; index += 1) {
    events.push(
      comment(`e${index + 2}`, LINES[index % LINES.length]!, start + (index + 1) * 10 * min)
    )
  }
  if (asked === 'note') {
    events.push(status('e20', 'working', 'needs_you', start + 100 * min, ASK))
  } else if (asked === 'question') {
    events.push(comment('e20', ASK, start + 100 * min))
    events.push(status('e21', 'working', 'needs_you', start + 100 * min))
  }
  for (let index = 0; index < 10; index += 1) {
    events.push(
      comment(`e${index + 30}`, LINES[(index + 2) % LINES.length]!, start + (index + 11) * 10 * min)
    )
  }
  return events
}

const read = (item: BotItem, events: BotItemEvent[], more: Partial<BotItemViewRead> = {}) => ({
  item,
  events,
  eventsRead: true,
  hasEarlier: false,
  failed: false,
  deleted: false,
  loadEarlier: () => {},
  retry: () => {},
  ...more
})

const pr = (number: number, title: string, state: 'open' | 'merged'): BotItemLinkView => ({
  kind: 'pr',
  ref: `acme/app#${number}`,
  pr: {
    shown: true,
    ref: `acme/app#${number}`,
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state,
    checks: 'success',
    review: null,
    title,
    checkedAt: now
  }
})
const SIX_LINKS: BotItemLinkView[] = [
  pr(41230, 'Share dialog: view-only links by default', 'open'),
  pr(41188, 'Share dialog scaffolding', 'merged'),
  { kind: 'url', ref: 'https://github.com/acme/app/issues/41201' },
  { kind: 'url', ref: 'https://example.com/docs/sharing' },
  { kind: 'file', ref: 'notes/share-dialog-mock.html' },
  { kind: 'file', ref: 'notes/report.md' }
]
const THREE_LINKS = SIX_LINKS.slice(0, 3)

const needsYou = makeTestBotItem(93, {
  title: 'Ship the share dialog',
  description: 'View-only links by default; the owner can widen a link from the dialog.',
  status: 'needs_you',
  links: THREE_LINKS
})

function Pane({
  item,
  view,
  owner = bot
}: {
  item: BotItem
  view: BotItemViewRead
  owner?: Bot
}): React.JSX.Element {
  return (
    <div className="flex h-[520px] flex-col bg-sidebar">
      <BotItemBody bot={owner} item={item} view={view} />
    </div>
  )
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
// The Activity's scroller, under the fixed top.
const scroller = (frame: HTMLElement) =>
  frame.querySelector<HTMLElement>('section .overflow-y-auto')

async function scrollToTop(frame: HTMLElement): Promise<void> {
  const node = scroller(frame)
  await wait(150)
  node?.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }))
  if (node) {
    node.scrollTop = 0
  }
  await wait(250)
}

async function clickPill(frame: HTMLElement, settle: number): Promise<void> {
  frame.querySelector<HTMLButtonElement>('[data-native-chat-jump-latest]')?.click()
  await wait(settle)
}

// The fixture frame pads 16px a side: these are 260px and 340px panes.
const NARROW = 260 + 32
const COMMON = 340 + 32

/** One state at the two widths the header has to hold: the narrowest pane and a common one. */
function both(
  render: () => React.JSX.Element,
  interact?: (frame: HTMLElement) => Promise<void>
): [ReturnType<typeof defineFixture>, ReturnType<typeof defineFixture>] {
  return [
    defineFixture({ width: NARROW, render, interact }),
    defineFixture({ width: COMMON, render, interact })
  ]
}

const noteView = read(needsYou, activity('note'))

// Needs you, read from the top: the entry that asked is below, so the pill reads Needs you and points down.
export const [needsYouBelow260, needsYouBelow340] = both(
  () => <Pane item={needsYou} view={noteView} />,
  scrollToTop
)

// Opened at the end, past the entry that asked: the Needs you pill points up.
export const [scrolledPast260, scrolledPast340] = both(
  () => <Pane item={needsYou} view={noteView} />,
  () => wait(300)
)

// After the pill: the entry sits under the header with its amber ring, the pill is gone, the box has focus.
export const [afterJump260, afterJump340] = both(
  () => <Pane item={needsYou} view={noteView} />,
  async (frame) => {
    await scrollToTop(frame)
    // Past the smooth scroll; shots end animations, so the ring's peak is drawn as a still frame.
    await clickPill(frame, 1200)
    const node = frame.querySelector<HTMLElement>('[data-bot-item-needs-you]')
    if (node) {
      const amber = getComputedStyle(node).getPropertyValue('--agent-question').trim()
      node.style.boxShadow = `0 0 0 2px ${amber}`
    }
  }
)

const olderHost = makeTestBotItem(94, {
  title: 'Ship the share dialog',
  status: 'needs_you',
  question: { eventId: 'e20', text: ASK },
  links: THREE_LINKS
})

// A prose question sits in Activity, above later comments.
export const [olderHostQuestion260, olderHostQuestion340] = both(
  () => <Pane item={olderHost} view={read(olderHost, activity('question'))} />,
  () => wait(300)
)

// The question is on an earlier page: the Needs you pill points up and, clicked, loads it.
export const [pendingJump260, pendingJump340] = both(
  () => (
    <Pane item={olderHost} view={read(olderHost, activity(null).slice(9), { hasEarlier: true })} />
  ),
  async (frame) => {
    // The Activity, and with it the pill, draws a frame after the top.
    await wait(150)
    await clickPill(frame, 200)
  }
)

const remoteBot = stampBotHost('runtime:fixture-remote', bot)
const questionEvents = activity('question')

function DelayedQuestion(): React.JSX.Element {
  const [requested, setRequested] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const loadEarlier = useCallback(() => setRequested(true), [])
  useEffect(() => {
    if (!requested) {
      return undefined
    }
    const timer = setTimeout(() => setLoaded(true), 1200)
    return () => clearTimeout(timer)
  }, [requested])
  const events = loaded ? questionEvents : questionEvents.slice(11)
  const view = read(olderHost, events, { hasEarlier: !loaded, loadEarlier })
  return <Pane item={olderHost} view={view} owner={remoteBot} />
}

export const [remoteEarlierQuestion260, remoteEarlierQuestion340] = both(() => <DelayedQuestion />)

const longTitle = makeTestBotItem(96, {
  title:
    'Fix share link recovery when the host restarts mid-write and the cached preference disagrees with disk',
  status: 'working',
  links: SIX_LINKS
})

// A two-line title and six links behind one count.
export const [longTitleSixLinks260, longTitleSixLinks340] = both(() => (
  <Pane item={longTitle} view={read(longTitle, activity(null))} />
))

// The six links' popover, open.
export const [linksOpen260, linksOpen340] = both(
  () => <Pane item={longTitle} view={read(longTitle, activity(null))} />,
  async (frame) => {
    await wait(150)
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="6 links"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    frame.querySelector<HTMLButtonElement>('button[aria-label="6 links"]')?.click()
    await wait(200)
  }
)

const oneLink = makeTestBotItem(97, {
  title: 'Translate the new share strings',
  status: 'working',
  links: SIX_LINKS.slice(0, 1)
})

// One link is its own chip.
export const [oneLink260, oneLink340] = both(() => (
  <Pane item={oneLink} view={read(oneLink, activity(null))} />
))

const noLinks = makeTestBotItem(98, { title: 'Translate the new share strings', status: 'working' })

// No links: the status alone.
export const [noLinks260, noLinks340] = both(() => <Pane item={noLinks} view={read(noLinks, [])} />)

const inProgress = makeTestBotItem(99, {
  title: 'Translate the new share strings',
  status: 'working',
  links: THREE_LINKS
})

// In progress, read from the top: the made entry's date shows; the plain Jump to latest.
export const [inProgress260, inProgress340] = both(
  () => <Pane item={inProgress} view={read(inProgress, activity(null))} />,
  scrollToTop
)

const snoozedItem = makeTestBotItem(100, {
  title: 'Ship the share dialog',
  status: 'needs_you',
  links: THREE_LINKS,
  snoozedUntil: now + 40 * 60 * min
})

// Snoozed while it needs the owner: the snooze line under the status row; the pill still leads up.
export const [snoozed260, snoozed340] = both(
  () => <Pane item={snoozedItem} view={read(snoozedItem, activity('note'))} />,
  () => wait(300)
)
