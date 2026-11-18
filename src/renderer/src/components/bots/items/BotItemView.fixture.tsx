import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemBody } from './BotItemView'

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
