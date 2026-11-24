import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem, BotItemLinkView } from '../../../../../shared/bots/bot-items'
import { BotItemPaneFrame } from './BotItemPane'
import { BotItemBody } from './BotItemView'
import type { BotItemWalkState } from './use-bot-item-walk'
import { createNativeChatFileHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'

const walk = (): BotItemWalkState => ({
  uid: 'uid-542',
  place: { index: 3, total: 14 },
  pending: false,
  failed: false,
  canStep: () => true,
  open: () => {},
  step: () => {},
  retry: () => {},
  markGone: () => {},
  close: () => null
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

// The calm page: back row and status on one line, the title pinned under it, then Done when, Links and
// where the item came from. Invented names, repos and paths only.
const CALM_AT = Date.UTC(2026, 10, 17, 19, 0)
const RUNBOOK = '/projects/launch/notes/global-stop-runbook.md'
const calmItem = makeTestBotItem(542, {
  title: 'Launch-day global stop for bots across every paired host',
  // As the description's path reads once Orca finds the file: linked to it.
  description: `Runbook: [${RUNBOOK}](${createNativeChatFileHref(RUNBOOK)})`,
  status: 'needs_you',
  doneMeans:
    'The owner has the stop and undo card, cloud access is verified read-only, and a backup operator is named',
  createdAt: CALM_AT
})
const calmPr = (
  number: number,
  title: string,
  checks: 'success' | 'failure',
  state: 'open' | 'merged' = 'open'
): BotItemLinkView => ({
  kind: 'pr',
  ref: `acme/app#${number}`,
  pr: {
    shown: true,
    ref: `acme/app#${number}`,
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state,
    checks,
    review: null,
    title,
    checkedAt: CALM_AT
  }
})
const LINEAR_ISSUE = (identifier: string, title: string, state: string) => ({
  data: {
    id: identifier,
    identifier,
    title,
    url: `https://linear.app/acme/issue/${identifier.toLowerCase()}`,
    state: { name: state, type: 'started', color: '#999999' },
    team: { id: 't1', name: 'Ops', key: 'OPS' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-11-17T00:00:00Z'
  },
  fetchedAt: CALM_AT
})
const calmStore = {
  linearIssueCache: {
    'OPS-1650': LINEAR_ISSUE('OPS-1650', 'Cloud read-only access', 'In Progress'),
    'OPS-1702': LINEAR_ISSUE('OPS-1702', 'Launch checklist', 'Todo')
  }
}
const calmThree: BotItemLinkView[] = [
  calmPr(46172, 'Global stop switch', 'success'),
  workerLink('ctx_stop', 'Stop runbook review', true),
  { kind: 'url', ref: 'https://linear.app/acme/issue/OPS-1650/cloud-read-only-access' }
]
const calmSeven: BotItemLinkView[] = [
  ...calmThree,
  calmPr(46210, 'Undo card copy', 'failure'),
  workerLink('ctx_drain', 'Relay drain check', false),
  { kind: 'file', ref: '/projects/launch/notes/backup-operator-rota.md' },
  { kind: 'url', ref: 'https://linear.app/acme/issue/OPS-1702/launch-checklist' }
]

function Calm({ shown, named = false }: { shown: BotItem; named?: boolean }): React.JSX.Element {
  const bot = { ...fixtureCos, name: 'Sample Bot', avatar: null }
  return (
    <div className="flex h-[640px] flex-col bg-sidebar">
      <BotItemPaneFrame walk={walk()} offline={false} onBack={() => {}} owner={named ? bot : null}>
        {({ comment, statusSlot, nav }) => (
          <BotItemBody
            commentRef={comment}
            statusSlot={statusSlot}
            nav={nav}
            bot={bot}
            item={shown}
            view={{
              item: shown,
              events: [],
              eventsRead: true,
              hasEarlier: false,
              failed: false,
              deleted: false,
              loadEarlier: () => {},
              retry: () => {}
            }}
          />
        )}
      </BotItemPaneFrame>
    </div>
  )
}

function calmAt(width: number, shown: BotItem, named = false) {
  return defineFixture({
    width,
    store: calmStore,
    render: () => <Calm shown={shown} named={named} />
  })
}
const SHORT_TITLE = { title: 'Global stop' }
export const calmThreeLinks = calmAt(340, { ...calmItem, links: calmThree })
export const calmSevenLinks = calmAt(340, { ...calmItem, links: calmSeven })
export const calmNoLinks = calmAt(340, { ...calmItem, ...SHORT_TITLE })
export const calmNoDoneWhen = calmAt(340, { ...calmItem, doneMeans: null, links: calmThree })
export const calmNarrowSeven = calmAt(260, { ...calmItem, links: calmSeven })
export const calmNarrowNamed = calmAt(260, { ...calmItem, links: calmThree }, true)
export const calmNarrowNoLinks = calmAt(260, { ...calmItem, doneMeans: null })
export const calmSnoozed = calmAt(340, {
  ...calmItem,
  links: calmThree,
  snoozedUntil: CALM_AT + 400 * 24 * 60 * 60_000
})
export const calmDone = calmAt(340, {
  ...calmItem,
  status: 'done',
  closeNote: 'Stop and undo verified on every host.',
  links: calmThree
})
export const calmCanceled = calmAt(260, {
  ...calmItem,
  status: 'canceled',
  closeNote: 'Launch moved to next week.',
  links: calmSeven
})

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

/** "2 more" clicked: every link shows in place, focus on the first one it showed. */
export const calmSevenExpanded = defineFixture({
  ...calmSevenLinks,
  interact: async (frame) => {
    const more = [...frame.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '2 more'
    )
    more?.click()
    await settle()
  }
})

/** The status menu, opened from the back row's right end. */
export const calmStatusMenu = defineFixture({
  ...calmThreeLinks,
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>('[data-bot-item-pane] fieldset button')
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await settle()
  }
})
