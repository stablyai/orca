import { describe, expect, it } from 'vitest'
import { compareProcessMetricDesc, sortByProcessMetric } from './sort-by-process-metric'

type Item = { name: string; cpu: number | null; memory: number | null; uptime: number | null }

const getters = {
  name: (item: Item) => item.name,
  cpu: (item: Item) => item.cpu,
  memory: (item: Item) => item.memory,
  uptime: (item: Item) => item.uptime
}

describe('compareProcessMetricDesc', () => {
  it('sorts biggest first', () => {
    expect(compareProcessMetricDesc(5, 10)).toBeGreaterThan(0)
    expect(compareProcessMetricDesc(10, 5)).toBeLessThan(0)
  })

  it('always sorts null/undefined last regardless of direction', () => {
    expect(compareProcessMetricDesc(null, 5)).toBeGreaterThan(0)
    expect(compareProcessMetricDesc(5, null)).toBeLessThan(0)
    expect(compareProcessMetricDesc(undefined, null)).toBe(0)
  })
})

describe('sortByProcessMetric', () => {
  const items: Item[] = [
    { name: 'beta', cpu: 1, memory: 100, uptime: 50 },
    { name: 'alpha', cpu: 5, memory: 10, uptime: null },
    { name: 'gamma', cpu: null, memory: 500, uptime: 200 }
  ]

  it('sorts by name ascending', () => {
    expect(sortByProcessMetric(items, 'name', getters).map((i) => i.name)).toEqual([
      'alpha',
      'beta',
      'gamma'
    ])
  })

  it('sorts by cpu descending, null last', () => {
    expect(sortByProcessMetric(items, 'cpu', getters).map((i) => i.name)).toEqual([
      'alpha',
      'beta',
      'gamma'
    ])
  })

  it('sorts by memory descending, null last', () => {
    expect(sortByProcessMetric(items, 'memory', getters).map((i) => i.name)).toEqual([
      'gamma',
      'beta',
      'alpha'
    ])
  })

  it('sorts by uptime descending, null last', () => {
    expect(sortByProcessMetric(items, 'uptime', getters).map((i) => i.name)).toEqual([
      'gamma',
      'beta',
      'alpha'
    ])
  })

  it('does not mutate the input array', () => {
    const copy = [...items]
    sortByProcessMetric(items, 'uptime', getters)
    expect(items).toEqual(copy)
  })
})
