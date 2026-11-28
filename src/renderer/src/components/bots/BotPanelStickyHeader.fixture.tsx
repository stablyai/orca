import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotPanelFrame,
  botPanelPage,
  fixtureCos,
  stubBotPanel
} from '../../component-fixtures/fixture-bot-panel'
import { RIGHT_SIDEBAR_MIN_WIDTH } from '../right-sidebar/layout/right-sidebar-width'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotItem } from '../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'

// A bot's Home with more items than fit: its header pinned at the top, before and after a scroll.
const now = Date.now()
const min = 60_000

const activity: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  automations: [],
  waits: [],
  upNext: { state: { running: false, seenAt: 0 }, items: [] }
}

const TITLES: [string, BotItem['status']][] = [
  ['Pick the release headline', 'needs_you'],
  ['Approve the changelog wording', 'needs_you'],
  ['Choose a color for the new badge', 'needs_you'],
  ['Confirm the beta cutoff date', 'needs_you'],
  ['Fix flaky reconnect test', 'working'],
  ['Draft release notes', 'working'],
  ['Clean up stale branches', 'working'],
  ['Triage the inbox', 'working'],
  ['Update the onboarding copy', 'working'],
  ['Check the nightly build', 'working'],
  ['Rename the settings section', 'working'],
  ['Trim unused icons', 'working'],
  ['Review the docs index', 'working'],
  ['Tidy the sample data', 'working']
]

const ITEMS = TITLES.map(([title, status], index) =>
  makeTestBotItem(200 - index, {
    title,
    status,
    lastActivityAt: now - (index + 1) * 7 * min
  })
)

const bot = { ...fixtureCos, name: 'Release Helper' }

// The page lays out and the items land before the shot; a scroll's observer notice lands a frame later.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))

type Then = (frame: HTMLElement, scroller: HTMLElement) => void | Promise<void>

function scene(width: number, scrolled: boolean, then?: Then) {
  return defineFixture({
    width,
    store: botPanelPage(true, null),
    setup: stubBotPanel(activity, bot, [], ITEMS),
    interact: async (frame) => {
      await settle()
      if (scrolled) {
        const scroller = frame.querySelector<HTMLElement>('[data-bot-items-scroller]')
        if (scroller) {
          scroller.scrollTop = 140
        }
        await settle()
      }
      const scroller = frame.querySelector<HTMLElement>('[data-bot-items-scroller]')
      if (then && scroller) {
        await then(frame, scroller)
        await settle()
      }
    },
    // A fixed height, so the list overflows and scrolls under the header.
    render: () => (
      <div className="flex h-[520px] flex-col *:min-h-0 *:flex-1">
        <BotPanelFrame />
      </div>
    )
  })
}

export const narrowTop = scene(RIGHT_SIDEBAR_MIN_WIDTH, false)
export const narrowScrolled = scene(RIGHT_SIDEBAR_MIN_WIDTH, true)
export const wideTop = scene(480, false)
export const wideScrolled = scene(480, true)

/** The "More" menu opened while rows are under the header: it draws over the header and the rows. */
export const wideScrolledMenu = scene(480, true, (frame) => {
  const more = frame.querySelector<HTMLElement>('[aria-label="More"]')
  more?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerType: 'mouse'
    })
  )
})
/** The gear's keyboard ring while pinned: whole, not cut by the header or the scroller. */
export const narrowScrolledFocus = scene(RIGHT_SIDEBAR_MIN_WIDTH, true, (frame) => {
  frame.querySelector<HTMLElement>('[data-bot-panel-gear]')?.focus({ focusVisible: true })
})
/** Scrolled to the end, then a row above takes focus (as Tab gives it): it scrolls in below the header. */
export const wideRowScrolledTo = scene(480, true, (frame, scroller) => {
  scroller.scrollTop = scroller.scrollHeight
  const rows = frame.querySelectorAll<HTMLElement>('[data-bot-item-open]')
  rows[1]?.focus({ focusVisible: true })
})
