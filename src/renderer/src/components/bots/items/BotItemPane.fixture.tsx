import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem, BotItemEvent, BotItemLinkView } from '../../../../../shared/bots/bot-items'
import { BotItemPaneFrame } from './BotItemPane'
import { BotItemBody, BotItemDeletedNotice } from './BotItemView'
import type { BotItemWalkState } from './use-bot-item-walk'

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
  hasEarlier = false
}: {
  state: BotItemWalkState
  shown?: BotItem
  offline?: boolean
  deleted?: boolean
  activity?: BotItemEvent[]
  hasEarlier?: boolean
}): React.JSX.Element {
  return (
    <div className="flex h-[420px] flex-col">
      <BotItemPaneFrame walk={state} offline={offline} onBack={() => {}}>
        {(comment) => (
          <BotItemBody
            commentRef={comment}
            bot={fixtureCos}
            item={shown}
            deleted={deleted}
            notice={deleted ? <BotItemDeletedNotice /> : null}
            view={{
              item: shown,
              events: activity,
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
