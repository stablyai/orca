import { describe, expect, it } from 'vitest'
import {
  estimatePluginAddedAt,
  formatAddedAgo,
  pickNewPlugins,
  pluginAddedAgeMs
} from './plugin-added-at'

const NOW = Date.parse('2026-11-09T12:00:00.000Z')
const HOUR = 3_600_000
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString()
const plugin = (id: string, addedAt: string | null): { id: string; addedAt: string | null } => ({
  id,
  addedAt
})
const addedAtOf = (item: { addedAt: string | null }): string | null => item.addedAt

describe('estimatePluginAddedAt', () => {
  it('takes the oldest dated release of a community plugin, in UTC', () => {
    const releases = [
      { updatedAt: '2026-11-08T10:00:00+08:00' },
      {},
      { updatedAt: '2026-11-05' },
      { updatedAt: '2026-11-07T00:00:00Z' }
    ]
    expect(estimatePluginAddedAt(releases, false)).toBe('2026-11-05T00:00:00.000Z')
  })

  it('leaves official plugins and undated releases undated', () => {
    expect(estimatePluginAddedAt([{ updatedAt: '2026-11-05' }], true)).toBeNull()
    expect(estimatePluginAddedAt([{}, { updatedAt: 'yesterday' }], false)).toBeNull()
    expect(estimatePluginAddedAt(undefined, false)).toBeNull()
  })
})

describe('pickNewPlugins', () => {
  it("lists dated plugins newest first, within the window, and counts this week's", () => {
    const plugins = [
      plugin('undated', null),
      plugin('week-old', ago(24 * 6)),
      plugin('fresh', ago(1)),
      plugin('stale', ago(24 * 45)),
      plugin('month', ago(24 * 20))
    ]
    expect(pickNewPlugins(plugins, addedAtOf, NOW)).toEqual({
      items: [
        plugin('fresh', ago(1)),
        plugin('week-old', ago(24 * 6)),
        plugin('month', ago(24 * 20))
      ],
      addedThisWeek: 2
    })
  })

  it('is empty while no catalog entry has a listing date', () => {
    expect(pickNewPlugins([plugin('a', null), plugin('b', null)], addedAtOf, NOW)).toEqual({
      items: [],
      addedThisWeek: 0
    })
  })

  it("never shows a date in the future or one that doesn't parse", () => {
    const plugins = [
      plugin('future', ago(-48)),
      plugin('garbled', 'soon'),
      plugin('skew', ago(-0.5))
    ]
    expect(pickNewPlugins(plugins, addedAtOf, NOW).items.map((p) => p.id)).toEqual(['skew'])
  })

  it('caps the row at nine by default', () => {
    const plugins = Array.from({ length: 12 }, (_, index) => plugin(`p${index}`, ago(index)))
    expect(pickNewPlugins(plugins, addedAtOf, NOW).items).toHaveLength(9)
    expect(pickNewPlugins(plugins, addedAtOf, NOW, { limit: 3 }).items.map((p) => p.id)).toEqual([
      'p0',
      'p1',
      'p2'
    ])
  })
})

describe('pluginAddedAgeMs', () => {
  it('clamps small clock skew to zero and rejects real future dates', () => {
    expect(pluginAddedAgeMs(ago(-0.5), NOW)).toBe(0)
    expect(pluginAddedAgeMs(ago(-2), NOW)).toBeNull()
    expect(pluginAddedAgeMs(undefined, NOW)).toBeNull()
  })
})

describe('formatAddedAgo', () => {
  it('reads like the website: just now, hours, then days', () => {
    expect(formatAddedAgo(ago(0.2), NOW)).toBe('just now')
    expect(formatAddedAgo(ago(-0.2), NOW)).toBe('just now')
    expect(formatAddedAgo(ago(1), NOW)).toBe('1 hour ago')
    expect(formatAddedAgo(ago(5), NOW)).toBe('5 hours ago')
    expect(formatAddedAgo(ago(30), NOW)).toBe('1 day ago')
    expect(formatAddedAgo(ago(24 * 3 + 2), NOW)).toBe('3 days ago')
  })

  it('falls back to the absolute date after two months, and to nothing for bad dates', () => {
    expect(formatAddedAgo('2026-08-01T00:00:00.000Z', NOW)).toBe('Aug 1, 2026')
    expect(formatAddedAgo(ago(-48), NOW)).toBeNull()
    expect(formatAddedAgo('soon', NOW)).toBeNull()
  })

  it('takes the UI locale and a translated just now', () => {
    expect(formatAddedAgo(ago(0.2), NOW, { justNow: 'à l’instant' })).toBe('à l’instant')
    expect(formatAddedAgo(ago(5), NOW, { locale: 'fr' })).toBe('il y a 5 heures')
  })
})
