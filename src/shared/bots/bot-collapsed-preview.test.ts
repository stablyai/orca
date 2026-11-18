import { describe, expect, it } from 'vitest'
import { collapsedBotPreview, type BotPreviewFacts } from './bot-collapsed-preview'
import { newestBotActivity } from './bot-row-activity'

function bot(id: string, facts: Partial<BotPreviewFacts> = {}) {
  return { id, status: 'active' as const, unread: false, paused: false, ...facts }
}

describe('collapsed bot preview', () => {
  it('ranks attention, unread, work and the rest without changing the expanded order', () => {
    const bots = [
      bot('idle'),
      bot('work', { status: 'working' }),
      bot('unread', { unread: true }),
      bot('needs', { status: 'permission', unread: true }),
      bot('failed', { attention: true }),
      bot('paused', { paused: true })
    ]
    const preview = collapsedBotPreview(bots)
    expect(preview.shown.map((entry) => entry.id)).toEqual([
      'needs',
      'failed',
      'unread',
      'work',
      'idle'
    ])
    expect(preview.hidden.map((entry) => entry.id)).toEqual(['paused'])
    expect(bots.map((entry) => entry.id)).toEqual([
      'idle',
      'work',
      'unread',
      'needs',
      'failed',
      'paused'
    ])
    expect(preview).toMatchObject({ total: 6, attention: 2, unread: 2, working: 1 })
  })

  it('preserves ties and reports omitted bots, including unread attention overlaps', () => {
    const bots = Array.from({ length: 8 }, (_, index) =>
      bot(String(index), { unread: true, status: index < 6 ? 'permission' : 'working' })
    )
    const preview = collapsedBotPreview(bots)
    expect(preview.shown.map((entry) => entry.id)).toEqual(['0', '1', '2', '3', '4'])
    expect(preview.hidden).toHaveLength(3)
    expect(preview.hiddenSignal).toBe('attention')
    expect(collapsedBotPreview(bots.slice(6), 1).hiddenSignal).toBe('unread')
    expect(collapsedBotPreview([bot('monitor', { status: 'monitoring' })], 0).hiddenSignal).toBe(
      'working'
    )
  })

  it('selects real current/recent activity with stable equal clocks and no invented fallback', () => {
    const rows = [
      { text: 'first', at: 3 },
      { text: 'second', at: 3 },
      { text: 'old', at: 1 }
    ]
    expect(newestBotActivity(rows, (row) => row.at)).toBe(rows[0])
    expect(newestBotActivity([], () => 0)).toBeNull()
  })
})
