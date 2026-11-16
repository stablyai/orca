import { expect, it } from 'vitest'
import { compareProjectEntries, sortProjectEntries } from './project-section-order'
import type { ProjectSectionEntry, ProjectSectionRepo } from './project-section-grouping'

type Entry = [string, ProjectSectionEntry<{ lastActivityAt: number }, ProjectSectionRepo>]

it('orders mixed personal and legacy summaries transitively regardless of catalog encounter order', () => {
  const a: Entry = [
    'a',
    { label: 'Alpha', items: [{ lastActivityAt: 30 }], repoIds: new Set(['a']) }
  ]
  const b: Entry = [
    'b',
    { label: 'Beta', items: [{ lastActivityAt: 10 }], repoIds: new Set(['b']) }
  ]
  const c: Entry = [
    'c',
    { label: 'Gamma', items: [], repoIds: new Set(['c']), projectPreference: {} }
  ]
  const manual = new Map([
    ['b', 0],
    ['c', 1],
    ['a', 2]
  ])
  const permutations = [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a]
  ]
  const results = permutations.map((entries) =>
    sortProjectEntries(entries, 'recent', manual).map(([key]) => key)
  )
  expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
    true
  )
  for (const [first, second, third] of permutations) {
    const compare = (left: Entry, right: Entry) =>
      compareProjectEntries(left, right, 'recent', (entry) => manual.get(entry[0]) ?? 0)
    if (compare(first, second) < 0 && compare(second, third) < 0) {
      expect(compare(first, third)).toBeLessThan(0)
    }
  }
})

it('preserves legacy activity recency when every host summary is absent', () => {
  const entries: Entry[] = [
    ['a', { label: 'Alpha', items: [{ lastActivityAt: 1 }], repoIds: new Set(['a']) }],
    ['b', { label: 'Beta', items: [{ lastActivityAt: 30 }], repoIds: new Set(['b']) }]
  ]
  expect(
    sortProjectEntries(
      entries,
      'recent',
      new Map([
        ['a', 0],
        ['b', 1]
      ])
    ).map(([key]) => key)
  ).toEqual(['b', 'a'])
})
