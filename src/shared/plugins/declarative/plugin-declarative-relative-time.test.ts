import { describe, expect, it } from 'vitest'
import { parsePluginDeclarativeTree } from './plugin-declarative-tree'
import {
  formatPluginRelativeTime,
  pluginRelativeTimeParts,
  pluginRelativeTimeTickMs
} from './plugin-declarative-relative-time'

const NOW = Date.UTC(2026, 10, 1, 12)

describe('relative time', () => {
  it('picks the largest whole unit and words it in each format', () => {
    expect(pluginRelativeTimeParts(-45_000)).toEqual({ value: -45, unit: 'second' })
    expect(pluginRelativeTimeParts(-5 * 60_000 - 10)).toEqual({ value: -5, unit: 'minute' })
    expect(pluginRelativeTimeParts(3 * 86_400_000)).toEqual({ value: 3, unit: 'day' })
    const at = NOW - 5 * 60_000
    expect(formatPluginRelativeTime(at, NOW, 'short', 'en')).toBe('5m ago')
    expect(formatPluginRelativeTime(at, NOW, 'long', 'en')).toBe('5 minutes ago')
    expect(formatPluginRelativeTime(at, NOW, 'duration', 'en')).toBe('5m')
    expect(formatPluginRelativeTime(NOW + 2 * 3_600_000, NOW, 'long', 'en')).toBe('in 2 hours')
  })

  it('ticks often only while the words change often', () => {
    expect(pluginRelativeTimeTickMs(-10_000)).toBe(1000)
    expect(pluginRelativeTimeTickMs(-10 * 60_000)).toBe(15_000)
    expect(pluginRelativeTimeTickMs(-5 * 3_600_000)).toBe(300_000)
  })

  it('accepts RelativeTime inside Text and relative Table cells', () => {
    const parsed = parsePluginDeclarativeTree({
      type: 'Stack',
      props: {},
      children: [
        {
          type: 'Text',
          props: {},
          children: ['Started ', { type: 'RelativeTime', props: { at: NOW, format: 'long' } }]
        },
        {
          type: 'Table',
          props: {
            label: 'Agents',
            columns: [{ key: 'since', label: 'Since' }],
            rows: [
              { key: 'a', cells: { since: { type: 'relative', at: NOW, format: 'duration' } } }
            ]
          }
        }
      ]
    })
    expect(parsed).toMatchObject({ ok: true, warnings: [] })
    const bad = parsePluginDeclarativeTree({
      type: 'RelativeTime',
      props: { at: Number.POSITIVE_INFINITY }
    })
    expect(bad.ok && bad.tree?.type).toBe('Unsupported')
  })
})
