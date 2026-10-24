import { describe, expect, it } from 'vitest'
import type { ProjectSectionEntry, ProjectSectionRepo } from './project-section-grouping'
import { sortProjectEntries } from './project-section-order'

type Entry = [string, ProjectSectionEntry<{ lastActivityAt?: number }, ProjectSectionRepo>]

function entry(id: string, label: string, lastActivityAt: number): Entry {
  return [
    id,
    {
      label,
      items: [{ lastActivityAt }],
      repo: { id, displayName: label, path: `/p/${id}` },
      repoIds: new Set([id])
    }
  ]
}

describe('sortProjectEntries name order', () => {
  it('orders projects by label regardless of manual rank or activity', () => {
    const entries = [entry('c', 'talkk-up', 300), entry('a', 'Marea', 100), entry('b', 'jig', 200)]
    const repoOrder = new Map([
      ['c', 0],
      ['a', 1],
      ['b', 2]
    ])
    expect(sortProjectEntries(entries, 'name', repoOrder).map(([, e]) => e.label)).toEqual([
      'jig',
      'Marea',
      'talkk-up'
    ])
  })
})
