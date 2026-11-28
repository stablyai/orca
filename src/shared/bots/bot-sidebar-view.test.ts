import { expect, it } from 'vitest'
import { arrangeBotSidebarEntries, DEFAULT_BOT_SIDEBAR_VIEW } from './bot-sidebar-view'

const bot = (name: string, pinned?: boolean) => ({
  kind: 'bot' as const,
  bot: { name, paused: false, pinned }
})

const idle = () => ({ needsYou: false, activityAt: 0 })

it('keeps a pinned bot above the others however the list is sorted', () => {
  const entries = [bot('Zed'), bot('Amy', true), bot('Mia')]
  expect(
    arrangeBotSidebarEntries(entries, DEFAULT_BOT_SIDEBAR_VIEW, idle).map((entry) => entry.bot.name)
  ).toEqual(['Amy', 'Zed', 'Mia'])
  expect(
    arrangeBotSidebarEntries(entries, { ...DEFAULT_BOT_SIDEBAR_VIEW, sortBy: 'name' }, idle).map(
      (entry) => entry.bot.name
    )
  ).toEqual(['Amy', 'Mia', 'Zed'])
})
