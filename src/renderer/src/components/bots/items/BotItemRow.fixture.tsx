import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { BotItemRow } from './BotItemRow'

const now = Date.now()
const min = 60_000

function inProgress(number: number, title: string, live: boolean, age: number): BotItem {
  return makeTestBotItem(number, {
    title,
    lastActivityAt: now - age * min,
    links: [
      {
        kind: 'dispatch',
        ref: `ctx_${number}`,
        latest: null,
        title: 'Worker',
        state: live ? 'working' : 'completed',
        host: null,
        startedAt: now - age * min,
        settledAt: live ? null : now - min,
        report: null,
        pr: null
      }
    ]
  })
}

function Row({ item }: { item: BotItem }): React.JSX.Element {
  return (
    <BotItemRow
      item={item}
      stale={false}
      snoozing={{ snooze: () => {}, pick: () => {}, dialog: null }}
      unseen={false}
      selected={false}
      selecting={false}
      now={now}
      onSelect={() => {}}
      onAction={() => {}}
    />
  )
}

// Status glyphs at one weight: a spinning and a static In progress row, then the other statuses.
export const statusGlyphs = defineFixture({
  width: 340,
  render: () => (
    <div role="list" className="@container bg-sidebar p-1">
      <Row item={inProgress(3, 'Fix flaky relay reconnect test', true, 16)} />
      <Row item={inProgress(4, 'Draft release notes for 1.4.240', false, 29)} />
      <Row
        item={makeTestBotItem(5, {
          title: 'Pick a name for the Items tab',
          status: 'needs_you',
          question: { eventId: 'e2', text: 'Items or Tasks? Items matches the CLI.' },
          lastActivityAt: now - 12 * min
        })}
      />
      <Row
        item={makeTestBotItem(6, {
          title: 'Audit stale worktrees',
          status: 'planned',
          lastActivityAt: now - 90 * min
        })}
      />
      <Row
        item={makeTestBotItem(7, {
          title: 'Hold mail while paused',
          status: 'done',
          lastActivityAt: now - 300 * min
        })}
      />
      <Row
        item={makeTestBotItem(8, {
          title: 'Old idea',
          status: 'canceled',
          lastActivityAt: now - 600 * min
        })}
      />
    </div>
  )
})

// A long title with its row focused: the actions fade over the title's end.
export const actionsOverLongTitle = defineFixture({
  width: 420,
  render: () => (
    <div role="list" className="@container bg-sidebar p-1">
      <Row
        item={makeTestBotItem(9, {
          title: 'Why worker-start --worktree current put a worker under Capstone Home',
          status: 'needs_you',
          question: { eventId: 'e3', text: 'Findings, all read-only (full report in the worker).' },
          lastActivityAt: now - 4 * min
        })}
      />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[data-bot-item-open]')?.focus({ focusVisible: false })
  }
})

// A narrow sidebar: Done, Snooze, and Cancel still fit over the title's end.
export const actionsNarrow = defineFixture({
  width: 240,
  render: () => (
    <div role="list" className="@container bg-sidebar p-1">
      <Row
        item={makeTestBotItem(10, {
          title: 'Pick a name for the Items tab',
          status: 'needs_you',
          question: { eventId: 'e4', text: 'Items or Tasks? Items matches the CLI.' },
          lastActivityAt: now - 12 * min
        })}
      />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[data-bot-item-open]')?.focus({ focusVisible: true })
  }
})
