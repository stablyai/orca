import { describe, expect, it } from 'vitest'

import {
  getProjectGroupHeaderSectionEndByGroupId,
  getRepoHeaderSectionEndByRepoId
} from './worktree-header-section-boundaries'
import type { RenderRow } from './worktree-list/listing/render-row'

const repoHeader = (id: string): RenderRow =>
  ({ type: 'header', key: `repo:${id}`, label: id, count: 1, tone: '', repo: { id } }) as RenderRow
const groupHeader = (id: string): RenderRow =>
  ({
    type: 'header',
    key: `group:${id}`,
    label: id,
    count: 1,
    tone: '',
    projectGroup: { id },
    projectGroupDepth: 0
  }) as RenderRow
const item = { type: 'item' } as RenderRow

// Estimated starts: first header 28, later headers 32, items 116.
const rows = [repoHeader('a'), item, repoHeader('b'), item, repoHeader('c'), item]
const startOfB = 28 + 116
const startOfC = startOfB + 32 + 116

describe('getRepoHeaderSectionEndByRepoId', () => {
  it('ends a section at the successor from the header’s own bucket', () => {
    const ends = getRepoHeaderSectionEndByRepoId({
      rows,
      firstHeaderIndex: 0,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:one', ['a', 'b']],
        ['group:two', ['a', 'c']]
      ]),
      repoHeaderBucketByRepoId: new Map([
        ['a', 'group:two'],
        ['b', 'group:one'],
        ['c', 'group:two']
      ])
    })

    // Regression: a successor index keyed on id alone picked `b` from the first bucket.
    expect(ends.get('a')).toBe(startOfC)
    expect(ends.get('b')).toBe(startOfC)
  })

  it('falls back to the next header when a bucket has no successor', () => {
    const ends = getRepoHeaderSectionEndByRepoId({
      rows,
      firstHeaderIndex: 0,
      sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', ['a']]]),
      repoHeaderBucketByRepoId: new Map([['a', 'ungrouped']])
    })

    expect(ends.get('a')).toBe(startOfB)
  })

  it('resolves a header id that renders twice to its first row, matching findIndex', () => {
    const ends = getRepoHeaderSectionEndByRepoId({
      rows: [repoHeader('a'), item, repoHeader('b'), item, repoHeader('b')],
      firstHeaderIndex: 0,
      sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', ['a', 'b', 'b']]]),
      repoHeaderBucketByRepoId: new Map([
        ['a', 'ungrouped'],
        ['b', 'ungrouped']
      ])
    })

    expect(ends.get('a')).toBe(startOfB)
    // The first `b` succeeds itself; a last-wins index would jump to the second `b` row.
    expect(ends.get('b')).toBe(startOfB)
  })
})

describe('getProjectGroupHeaderSectionEndByGroupId', () => {
  it('ends a section at the successor from the group’s own bucket', () => {
    const ends = getProjectGroupHeaderSectionEndByGroupId({
      rows: [groupHeader('a'), item, groupHeader('b'), item, groupHeader('c'), item],
      firstHeaderIndex: 0,
      sidebarProjectGroupHeaderIdsByBucket: new Map([
        ['root', ['a', 'b']],
        ['parent:x', ['a', 'c']]
      ]),
      projectGroupHeaderBucketByGroupId: new Map([
        ['a', 'parent:x'],
        ['b', 'root'],
        ['c', 'parent:x']
      ])
    })

    expect(ends.get('a')).toBe(startOfC)
  })
})
