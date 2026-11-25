import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from './bot-item.test-fixture'
import { botNeedsYouInboxRows } from './bot-needs-you-inbox-order'

const NOW = 1_800_000_000_000
const item = (
  number: number,
  botId: string,
  lastActivityAt: number,
  snoozedUntil: number | null = null
) =>
  makeTestBotItem(number, {
    status: 'needs_you',
    owner: { botId, name: botId },
    lastActivityAt,
    snoozedUntil
  })

const uids = (rows: readonly { number: number }[]) => rows.map((row) => row.number)

describe('botNeedsYouInboxRows', () => {
  const items = [
    item(1, 'docs', NOW - 1_000),
    item(2, 'release', NOW - 5_000),
    item(3, 'docs', NOW - 9_000),
    item(4, 'triage', NOW - 5_000),
    // Back from a snooze half a second ago: it waits from then, not from its last activity.
    item(5, 'release', NOW - 60_000_000, NOW - 500)
  ]

  it('lists the longest waiting first, a tie by number', () => {
    expect(uids(botNeedsYouInboxRows(items, 'oldest', [], NOW))).toEqual([3, 2, 4, 1, 5])
  })

  it('groups by bot in the sidebar order, longest waiting first in each, unknown bots last', () => {
    expect(uids(botNeedsYouInboxRows(items, 'bot', ['release', 'docs'], NOW))).toEqual([
      2, 5, 3, 1, 4
    ])
  })

  it('leaves its input as it was', () => {
    const before = uids(items)
    botNeedsYouInboxRows(items, 'bot', ['triage'], NOW)
    expect(uids(items)).toEqual(before)
  })
})
