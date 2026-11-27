// Where a side-panel row's hover card opens: left of the panel, over a stand-in main view, top at the
// row's (shifted up at the window's bottom), covering nothing in the panel.
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureAutomation,
  fixtureChat,
  fixtureCos,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotItem } from '../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'

const now = Date.now()
const min = 60_000
const owner = { botId: fixtureCos.id, name: fixtureCos.name }

const asking = (number: number, title: string, gist: string, ask: string): BotItem =>
  makeTestBotItem(number, {
    owner,
    title,
    status: 'needs_you',
    lastActivityAt: now - (number - 830) * min,
    question: {
      eventId: `e${number}`,
      text: `${gist}\n\n${ask}`,
      gist,
      decisions: [
        {
          question: ask,
          replies: [
            { label: 'Merge', recommended: true },
            { label: 'Hold', recommended: false }
          ]
        }
      ]
    }
  })
const working = (number: number, title: string, ago: number): BotItem =>
  makeTestBotItem(number, {
    owner,
    title,
    status: 'working',
    lastActivityAt: now - ago * min
  })

const ITEMS: BotItem[] = [
  asking(
    836,
    'Host-aware worker placement design',
    'The design PR is up for a look.',
    'Merge the guide-only PR (changes how coordinators place workers)?'
  ),
  asking(
    851,
    'Rotate the staging API keys',
    'The new keys are in the vault.',
    'Switch staging over?'
  ),
  asking(842, 'Relay auth for paired bots', 'The auth PR passed review.', 'Merge it now?'),
  asking(845, 'Zip import parser fix', 'CI is green on the fix.', 'Merge the parser fix?'),
  asking(
    847,
    'Release notes for the next build',
    'The draft is in the release doc.',
    'Merge the notes PR (adds the new Bots section)?'
  ),
  asking(840, 'Bump the Electron version', 'The bump PR is green.', 'Merge the bump?'),
  working(593, 'Skill out-of-date dialog: side by side', 1),
  working(307, 'App rail sidebar: pick a design', 6),
  working(890, 'Design: pin bots to top of Bots list', 18),
  working(889, 'Fix Slack reapproval with a stale token', 19),
  working(870, 'Relay reconnect backoff', 26)
]

const ACTIVITY: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [
    {
      ...fixtureAutomation('a-linear', 'Label new Linear bugs', 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0'),
      failing: true,
      latestRunId: 'r-linear'
    }
  ],
  waits: [],
  upNext: { state: { running: false, seenAt: 1 }, items: [] }
}

const CHATS = [
  fixtureChat('home', 'Home Chat', {
    origin: 'home',
    tab: true,
    lastActiveAt: now - 4 * min,
    running: [
      {
        key: 'w1',
        title: 'Phone: one Bots list across computers',
        branch: 'alice/phone-one-bots-list',
        state: 'running',
        startedAt: now - 26 * min,
        dispatchId: 'w1'
      }
    ]
  })
]

/** The panel at `panelWidth` beside a stand-in main view, its rect marked as the right sidebar's. */
function PanelBesideMain({ panelWidth }: { panelWidth: number }): React.JSX.Element {
  return (
    <div className="flex h-[720px]">
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-6">
        <p className="text-2xl text-foreground">Main view</p>
        <p className="text-sm text-muted-foreground">
          Row hover cards open over this area, beside the panel.
        </p>
      </div>
      <div
        data-right-sidebar-panel=""
        className="flex h-full flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1"
        style={{ width: panelWidth }}
      >
        <BotPanelFrame />
      </div>
    </div>
  )
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A real pointer path as React reads it: over/out pairs carry the enter and leave. */
function pointerTo(target: Element, from: Element | null): void {
  const init = { bubbles: true, pointerType: 'mouse' }
  if (from) {
    from.dispatchEvent(new PointerEvent('pointerout', { ...init, relatedTarget: target }))
  }
  target.dispatchEvent(new PointerEvent('pointerover', { ...init, relatedTarget: from }))
  target.dispatchEvent(new PointerEvent('pointermove', init))
}

/** A cursor drawn where the pointer is, since the capture shows none. */
function drawPointer(frame: HTMLElement, x: number, y: number): void {
  const cursor = document.createElement('div')
  cursor.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:100;pointer-events:none;width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:16px solid #e11d48;transform:rotate(-30deg);transform-origin:top left`
  frame.appendChild(cursor)
}

type Place = 'top' | 'middle' | 'last'

/** Hover the row named `name`; `last` first moves it to the window's bottom. */
function hoverRow(name: string, place: Place, intoCard = false, tab: 'chats' | null = null) {
  return async (frame: HTMLElement): Promise<void> => {
    await wait(400)
    if (tab === 'chats') {
      frame.querySelector<HTMLButtonElement>('button[aria-label="Unfold Home Chat"]')?.click()
      await wait(300)
    }
    let row: HTMLElement | undefined
    // The rows arrive with the host's read: wait for the named one to lay out.
    for (let tries = 0; tries < 30 && !row; tries++) {
      row = [...frame.querySelectorAll<HTMLElement>('button')].find(
        (button) =>
          (button.getAttribute('aria-label') ?? button.textContent ?? '').includes(name) &&
          button.getBoundingClientRect().width > 0
      )
      if (!row) {
        await wait(100)
      }
    }
    if (!row) {
      throw new Error(`Fixture row did not appear: ${name}`)
    }
    const panel = frame.querySelector<HTMLElement>('[data-right-sidebar-panel]')
    if (panel && place === 'last') {
      // Move the main view and panel down together so the row sits at the window's bottom, where
      // the card must shift up to stay inside it.
      const outer = panel.parentElement!
      outer.style.marginTop = `${window.innerHeight - 6 - row.getBoundingClientRect().bottom}px`
      await wait(50)
    }
    pointerTo(row, null)
    const rowBox = row.getBoundingClientRect()
    await wait(700)
    const card = document.querySelector<HTMLElement>(
      '[data-slot="hover-card-content"][data-state="open"]'
    )
    if (!card) {
      throw new Error(`Preview did not open for fixture row: ${name}`)
    }
    if (!intoCard) {
      drawPointer(frame, rowBox.left + 60, rowBox.top + rowBox.height / 2)
      return
    }
    pointerTo(card, row)
    const cardBox = card.getBoundingClientRect()
    await wait(400)
    if (!card.isConnected || card.dataset.state !== 'open') {
      throw new Error(`Preview closed on pointer entry for fixture row: ${name}`)
    }
    drawPointer(frame, cardBox.left + 40, cardBox.bottom - 18)
  }
}

const itemsFixture = (panelWidth: number, place: Place, intoCard = false) =>
  defineFixture({
    width: 900,
    store: botPanelPage(true, null),
    setup: stubBotPanel(ACTIVITY, fixtureCos, [], ITEMS),
    render: () => <PanelBesideMain panelWidth={panelWidth} />,
    interact: hoverRow(
      place === 'top' ? 'Host-aware worker placement' : 'Release notes for the next build',
      place,
      intoCard
    )
  })

export const itemTopNarrow = itemsFixture(280, 'top')
export const itemTopWide = itemsFixture(440, 'top')
export const itemMiddleNarrow = itemsFixture(280, 'middle')
export const itemMiddleWide = itemsFixture(440, 'middle')
export const itemLastNarrow = itemsFixture(280, 'last')
export const itemLastWide = itemsFixture(440, 'last')
export const itemPointerInCard = itemsFixture(280, 'top', true)

/** An automation row's card (a panel row, like chats and Up next). */
export const automationRow = defineFixture({
  width: 900,
  store: botPanelPage(true, null),
  setup: stubBotPanel(ACTIVITY, fixtureCos, [], ITEMS),
  render: () => <PanelBesideMain panelWidth={280} />,
  interact: hoverRow('Label new Linear bugs', 'middle')
})

/** A worker row's card, in the Chats tab. */
export const workerRow = defineFixture({
  width: 900,
  store: { ...botPanelPage(true, null), rightSidebarTab: 'bot-chats' as const },
  setup: stubBotPanel(ACTIVITY, fixtureCos, CHATS),
  render: () => <PanelBesideMain panelWidth={280} />,
  interact: hoverRow('Phone: one Bots list', 'top', false, 'chats')
})
