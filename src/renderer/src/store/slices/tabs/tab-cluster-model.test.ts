import { describe, expect, it } from 'vitest'
import { getHiddenClusterTabIds, type TabCluster } from '../../../../../shared/tab-types'
import {
  getTabClusterForTab,
  isTabClusterColor,
  mergeTabClusterRecords,
  normalizeTabClusters,
  rekeyTabClusterMembers
} from './tab-cluster-model'

function cluster(id: string, tabIds: string[], overrides: Partial<TabCluster> = {}): TabCluster {
  return { id, name: '', color: 'blue', collapsed: false, tabIds, ...overrides }
}

const unpinned = new Set<string>()

describe('normalizeTabClusters', () => {
  it('joins an unclustered tab sandwiched between members without changing pane order', () => {
    const tabOrder = ['a', 'between', 'b', 'outside']
    expect(
      normalizeTabClusters({
        tabOrder,
        clusters: [cluster('c', ['b', 'a'])],
        pinnedTabIds: unpinned
      })
    ).toEqual([cluster('c', ['a', 'between', 'b'])])
    expect(tabOrder).toEqual(['a', 'between', 'b', 'outside'])
  })

  it('keeps the longest run when an unrelated run separates the members', () => {
    expect(
      normalizeTabClusters({
        tabOrder: ['a', 'b', 'x', 'y', 'c', 'd', 'e'],
        clusters: [cluster('c', ['a', 'b', 'c', 'd', 'e'])],
        pinnedTabIds: unpinned
      })
    ).toEqual([cluster('c', ['c', 'd', 'e'])])
  })

  it('keeps the earliest run on ties', () => {
    expect(
      normalizeTabClusters({
        tabOrder: ['a', 'b', 'x', 'y', 'c', 'd'],
        clusters: [cluster('c', ['a', 'b', 'c', 'd'])],
        pinnedTabIds: unpinned
      })
    ).toEqual([cluster('c', ['a', 'b'])])
  })

  it('drops pinned, duplicate and stale members; the first cluster owns a repeated member', () => {
    expect(
      normalizeTabClusters({
        tabOrder: ['pin', 'a', 'b', 'c'],
        clusters: [
          cluster('first', ['pin', 'a', 'a', 'b', 'missing']),
          cluster('second', ['b', 'c'])
        ],
        pinnedTabIds: new Set(['pin'])
      })
    ).toEqual([cluster('first', ['a', 'b']), cluster('second', ['c'])])
  })

  it('does not sandwich-join a pinned tab', () => {
    expect(
      normalizeTabClusters({
        tabOrder: ['a', 'pin', 'b'],
        clusters: [cluster('c', ['a', 'b'])],
        pinnedTabIds: new Set(['pin'])
      })
    ).toEqual([cluster('c', ['a'])])
  })

  it('does not steal a sandwich member from another cluster', () => {
    expect(
      normalizeTabClusters({
        tabOrder: ['a', 'other', 'b'],
        clusters: [cluster('first', ['a', 'b']), cluster('second', ['other'])],
        pinnedTabIds: unpinned
      })
    ).toEqual([cluster('first', ['a']), cluster('second', ['other'])])
  })

  it('returns the original array and records for normal form, including a second repair', () => {
    const clusters = [cluster('c', ['a', 'b'], { collapsed: true, shownTabId: 'a' })]
    expect(normalizeTabClusters({ tabOrder: ['a', 'b'], clusters, pinnedTabIds: unpinned })).toBe(
      clusters
    )
    const repaired = normalizeTabClusters({
      tabOrder: ['a', 'b'],
      clusters: [cluster('c', ['b', 'a'], { collapsed: true, shownTabId: 'a' })],
      pinnedTabIds: unpinned
    })
    expect(
      normalizeTabClusters({ tabOrder: ['a', 'b'], clusters: repaired, pinnedTabIds: unpinned })
    ).toBe(repaired)
  })

  it.each([
    {
      reason: 'expanded',
      tabOrder: ['a', 'b'],
      members: ['a', 'b'],
      collapsed: false,
      pinnedTabIds: [],
      expectedMembers: ['a', 'b']
    },
    {
      reason: 'removed',
      tabOrder: ['b'],
      members: ['a', 'b'],
      collapsed: true,
      pinnedTabIds: [],
      expectedMembers: ['b']
    },
    {
      reason: 'pinned',
      tabOrder: ['a', 'b'],
      members: ['a', 'b'],
      collapsed: true,
      pinnedTabIds: ['a'],
      expectedMembers: ['b']
    },
    {
      reason: 'outside the surviving run',
      tabOrder: ['a', 'x', 'y', 'b', 'c'],
      members: ['a', 'b', 'c'],
      collapsed: true,
      pinnedTabIds: [],
      expectedMembers: ['b', 'c']
    }
  ])('drops the shown member when $reason and stays idempotent', (scenario) => {
    const pinnedTabIds = new Set(scenario.pinnedTabIds)
    const repaired = normalizeTabClusters({
      tabOrder: scenario.tabOrder,
      clusters: [
        cluster('c', scenario.members, { collapsed: scenario.collapsed, shownTabId: 'a' })
      ],
      pinnedTabIds
    })
    expect(repaired).toEqual([
      cluster('c', scenario.expectedMembers, { collapsed: scenario.collapsed })
    ])
    expect(Object.hasOwn(repaired?.[0] ?? {}, 'shownTabId')).toBe(false)
    expect(
      normalizeTabClusters({ tabOrder: scenario.tabOrder, clusters: repaired, pinnedTabIds })
    ).toBe(repaired)
  })

  it('removes empty clusters and omits the array when no members survive', () => {
    expect(
      normalizeTabClusters({
        tabOrder: ['a'],
        clusters: [cluster('empty', []), cluster('stale', ['gone'])],
        pinnedTabIds: unpinned
      })
    ).toBeUndefined()
    expect(
      normalizeTabClusters({ tabOrder: [], clusters: [], pinnedTabIds: unpinned })
    ).toBeUndefined()
  })

  it('trims names, repairs invalid colors and coerces collapsed state', () => {
    const malformed = cluster('c', ['a'], { name: '  Work  ' })
    Reflect.set(malformed, 'color', 'sepia')
    Reflect.set(malformed, 'collapsed', 1)
    Reflect.set(malformed, 'shownTabId', 42)
    expect(
      normalizeTabClusters({ tabOrder: ['a'], clusters: [malformed], pinnedTabIds: unpinned })
    ).toEqual([cluster('c', ['a'], { name: 'Work', color: 'grey', collapsed: true })])
  })
})

describe('cluster membership projections', () => {
  it('hides collapsed members except the active tab without expanding any cluster', () => {
    const clusters = [
      cluster('collapsed', ['a', 'b', 'c'], { collapsed: true }),
      cluster('open', ['d'])
    ]
    expect([...getHiddenClusterTabIds({ tabClusters: clusters, activeTabId: 'b' })]).toEqual([
      'a',
      'c'
    ])
    expect(clusters[0].collapsed).toBe(true)
    expect(getTabClusterForTab(clusters, 'c')).toBe(clusters[0])
    expect(getTabClusterForTab(clusters, 'missing')).toBeNull()
  })

  it('keeps the collapse-time member visible alongside whichever member is currently active', () => {
    const clusters = [cluster('c', ['a', 'b', 'c'], { collapsed: true, shownTabId: 'a' })]
    expect([...getHiddenClusterTabIds({ tabClusters: clusters, activeTabId: 'outside' })]).toEqual([
      'b',
      'c'
    ])
    expect([...getHiddenClusterTabIds({ tabClusters: clusters, activeTabId: 'b' })]).toEqual(['c'])
    expect([...getHiddenClusterTabIds({ tabClusters: clusters, activeTabId: 'outside' })]).toEqual([
      'b',
      'c'
    ])
    expect(clusters[0].shownTabId).toBe('a')
  })

  it('rekeys cluster members and leaves unchanged records referentially stable', () => {
    const clusters = [
      cluster('c', ['old', 'b'], { collapsed: true, shownTabId: 'old' }),
      cluster('untouched', ['c'])
    ]
    const rekeyed = rekeyTabClusterMembers(clusters, new Map([['old', 'new']]))
    expect(rekeyed?.[0].tabIds).toEqual(['new', 'b'])
    expect(rekeyed?.[0].shownTabId).toBe('new')
    expect(rekeyed?.[1]).toBe(clusters[1])
    expect(rekeyTabClusterMembers(clusters, new Map([['unrelated', 'new']]))).toBe(clusters)
    expect(rekeyTabClusterMembers(undefined, new Map())).toBeUndefined()
  })

  it('accepts palette colors but not arbitrary color names or non-strings', () => {
    expect(isTabClusterColor('orange')).toBe(true)
    expect(isTabClusterColor('sepia')).toBe(false)
    expect(isTabClusterColor(null)).toBe(false)
  })

  it('carries every incoming record and changes only colliding cluster ids', () => {
    const destination = cluster('same', ['a'])
    const incoming = cluster('same', ['b'], {
      name: 'Source',
      collapsed: true,
      shownTabId: 'b'
    })
    const result = mergeTabClusterRecords([destination], [incoming, cluster('unique', ['c'])])
    expect(result?.[0]).toBe(destination)
    expect(result?.[1]).toMatchObject({
      name: 'Source',
      collapsed: true,
      tabIds: ['b'],
      shownTabId: 'b'
    })
    expect(result?.[1].id).not.toBe('same')
    expect(result?.[2].id).toBe('unique')
  })
})
