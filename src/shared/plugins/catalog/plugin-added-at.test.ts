import { describe, expect, it } from 'vitest'
import { estimatePluginAddedAt, pickNewPlugins, pluginAddedAgeMs } from './plugin-added-at'

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
  it('lists dated plugins newest first, within the window', () => {
    const plugins = [
      plugin('undated', null),
      plugin('week-old', ago(24 * 6)),
      plugin('fresh', ago(1)),
      plugin('stale', ago(24 * 45)),
      plugin('month', ago(24 * 20))
    ]
    expect(pickNewPlugins(plugins, addedAtOf, NOW)).toEqual([
      plugin('fresh', ago(1)),
      plugin('week-old', ago(24 * 6)),
      plugin('month', ago(24 * 20))
    ])
  })

  it('is empty while no catalog entry has a listing date', () => {
    expect(pickNewPlugins([plugin('a', null), plugin('b', null)], addedAtOf, NOW)).toEqual([])
  })

  it("never shows a date in the future or one that doesn't parse", () => {
    const plugins = [
      plugin('future', ago(-48)),
      plugin('garbled', 'soon'),
      plugin('skew', ago(-0.5))
    ]
    expect(pickNewPlugins(plugins, addedAtOf, NOW).map((p) => p.id)).toEqual(['skew'])
  })

  it('caps the row at nine by default', () => {
    const plugins = Array.from({ length: 12 }, (_, index) => plugin(`p${index}`, ago(index)))
    expect(pickNewPlugins(plugins, addedAtOf, NOW)).toHaveLength(9)
    expect(pickNewPlugins(plugins, addedAtOf, NOW, { limit: 3 }).map((p) => p.id)).toEqual([
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
