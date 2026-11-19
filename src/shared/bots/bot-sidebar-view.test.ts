import { describe, expect, it } from 'vitest'
import {
  arrangeBotSidebarEntries,
  normalizeBotSidebarView,
  type BotSidebarView
} from './bot-sidebar-view'

type Entry =
  | { kind: 'bot'; id: string; bot: { name: string; paused: boolean; createdAt?: number } }
  | { kind: 'group'; id: string; group: { name: string } }

const bot = (id: string, name: string, paused = false): Entry => ({
  kind: 'bot',
  id,
  bot: { name, paused }
})

// Saved (Manual) order.
const entries: Entry[] = [
  bot('release', 'Release manager'),
  bot('docs', 'docs bot', true),
  { kind: 'group', id: 'room', group: { name: 'Launch room' } },
  bot('review', 'PR review bot'),
  bot('disk', 'Disk Space')
]
const activity: Record<string, { needsYou: boolean; activityAt: number }> = {
  release: { needsYou: false, activityAt: 500 },
  docs: { needsYou: false, activityAt: 900 },
  room: { needsYou: false, activityAt: 700 },
  review: { needsYou: true, activityAt: 100 },
  disk: { needsYou: false, activityAt: 500 }
}

function arrange(view: Partial<BotSidebarView>): string[] {
  return arrangeBotSidebarEntries(
    entries,
    { ...normalizeBotSidebarView(undefined), ...view },
    (entry) => activity[entry.id]!
  ).map((entry) => entry.id)
}

describe('arrangeBotSidebarEntries', () => {
  it('lists a just-made bot, with no activity yet, as the newest in Recent and Agent Activity', () => {
    const made: Entry[] = [
      ...entries,
      { kind: 'bot', id: 'made', bot: { name: 'New bot', paused: false, createdAt: 1000 } }
    ]
    const order = (sortBy: BotSidebarView['sortBy']): string[] =>
      arrangeBotSidebarEntries(made, { ...normalizeBotSidebarView(undefined), sortBy }, (entry) =>
        entry.id === 'made' ? { needsYou: false, activityAt: 0 } : activity[entry.id]!
      ).map((entry) => entry.id)
    expect(order('recent')).toEqual(['made', 'docs', 'room', 'release', 'disk', 'review'])
    expect(order('smart')).toEqual(['review', 'made', 'docs', 'room', 'release', 'disk'])
  })

  it('orders by name, ignoring case, in Name', () => {
    expect(arrange({ sortBy: 'name' })).toEqual(['disk', 'docs', 'room', 'review', 'release'])
  })

  it('hides paused bots but never a group', () => {
    expect(arrange({ sortBy: 'manual', hidePausedBots: true })).toEqual([
      'release',
      'room',
      'review',
      'disk'
    ])
  })
})

describe('normalizeBotSidebarView', () => {
  it('reads a missing or unknown saved value as Manual with nothing hidden', () => {
    expect(normalizeBotSidebarView({ sortBy: 'repo', hidePausedBots: 'yes' })).toEqual({
      sortBy: 'manual',
      hidePausedBots: false,
      hideSleepingWorkers: false
    })
  })
})
