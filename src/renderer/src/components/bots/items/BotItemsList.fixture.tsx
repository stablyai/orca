import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { groupBotItems } from '../../../../../shared/bots/bot-item-groups'
import { BotItemsList } from './BotItemsList'

const now = Date.now()
const min = 60_000

const bot: Bot = {
  id: 'fixture-bot',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const closedTitles = [
  'Ship the relay reconnect fix',
  'Rename the Items tab',
  'Draft release notes for 1.4.240',
  'Answer the Slack thread about pricing',
  'Bump the Electron version',
  'Clean up stale worktrees',
  'Triage Linear inbox',
  'Fix the sidebar search overlap'
]

const items = [
  makeTestBotItem(40, { title: 'Fix flaky relay reconnect test', lastActivityAt: now - 3 * min }),
  makeTestBotItem(41, {
    title: 'Pick a name for the export menu',
    status: 'planned',
    lastActivityAt: now - 20 * min
  }),
  ...closedTitles.map((title, index) =>
    makeTestBotItem(30 - index, {
      title,
      status: index % 3 === 2 ? 'canceled' : 'done',
      lastActivityAt: now - (index + 1) * 45 * min
    })
  )
]

// Closed starts open: its newest five, then Show more; Planned stays folded.
export const closedOpen = defineFixture({
  width: 340,
  render: () => (
    <div className="@container bg-sidebar p-1">
      <BotItemsList
        bot={bot}
        groups={groupBotItems(items, null, now, 'e10')}
        seenEventId="e10"
        closedTotal={12}
        onMoreClosed={null}
        staleDays={null}
        now={now}
        onOpen={() => {}}
      />
    </div>
  )
})

const hour = 60 * min
const snoozeItems = [
  makeTestBotItem(41, {
    title: 'Pick the release headline',
    status: 'needs_you',
    question: { eventId: 'e41', text: 'A or B for the Nov 20 note? Drafts linked.' },
    lastActivityAt: now - 2 * hour
  }),
  makeTestBotItem(38, {
    title: 'Approve staging cutover window',
    status: 'needs_you',
    question: { eventId: 'e38', text: 'OK to cut over Saturday 6 AM ET?' },
    lastActivityAt: now - 26 * hour
  }),
  makeTestBotItem(36, {
    title: 'Rename Look around in settings copy',
    status: 'needs_you',
    question: { eventId: 'e36', text: 'Explore or Look for work?' },
    lastActivityAt: now - 3 * 24 * hour,
    snoozedUntil: now + 40 * hour
  }),
  makeTestBotItem(33, { title: 'Upgrade the relay base image', lastActivityAt: now - 14 * min }),
  makeTestBotItem(29, {
    title: 'Audit unused connector scopes',
    status: 'planned',
    lastActivityAt: now - 4 * 24 * hour,
    snoozedUntil: now + 5 * 24 * hour
  })
]

// Snoozed after Planned, unfolded: soonest back first, each with its wake time; Needs you counts 2.
export const snoozed = defineFixture({
  width: 340,
  render: () => (
    <div className="@container bg-sidebar p-1">
      <BotItemsList
        bot={bot}
        groups={groupBotItems(snoozeItems, 5, now, 'e10')}
        seenEventId="e10"
        closedTotal={0}
        onMoreClosed={null}
        staleDays={5}
        now={now}
        onOpen={() => {}}
      />
    </div>
  ),
  interact: async (frame) => {
    const header = [...frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(
      (button) => button.textContent?.startsWith('Snoozed')
    )
    if (header?.getAttribute('aria-expanded') === 'false') {
      header.click()
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
