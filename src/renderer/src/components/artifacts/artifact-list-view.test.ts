import { describe, expect, it } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import {
  DEFAULT_ARTIFACT_LIST_SORT,
  EMPTY_ARTIFACT_LIST_FILTER,
  filterArtifactList,
  nextArtifactListSort,
  sortArtifactList
} from './artifact-list-view'

const NOW = Date.parse('2026-06-15T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function item(slug: string, updatedAt: string, expiresAt: string, title = slug): ArtifactListItem {
  return {
    shareUrl: `https://example.com/a/${slug}`,
    artifact: {
      version: 1,
      slug,
      title,
      originalFileName: null,
      sourceContentType: 'text/markdown',
      renderedContentType: 'text/html',
      createdAt: updatedAt,
      updatedAt,
      expiresAt,
      byteSize: 1,
      deletedAt: null
    }
  }
}

const slugs = (items: readonly ArtifactListItem[]): string[] =>
  items.map(({ artifact }) => artifact.slug)

describe('sortArtifactList', () => {
  it('puts unparseable dates last in both directions and keeps load order on ties', () => {
    const rows = [
      item('bad', 'not-a-date', 'x'),
      item('old', '2026-01-01T00:00:00Z', 'x'),
      item('tieA', '2026-03-01T00:00:00Z', 'x'),
      item('tieB', '2026-03-01T00:00:00Z', 'x')
    ]
    expect(slugs(sortArtifactList(rows, { field: 'updated', direction: 'asc' }, 'en'))).toEqual([
      'old',
      'tieA',
      'tieB',
      'bad'
    ])
    expect(slugs(sortArtifactList(rows, { field: 'updated', direction: 'desc' }, 'en'))).toEqual([
      'tieA',
      'tieB',
      'old',
      'bad'
    ])
  })

  it('orders names numerically, not by code unit', () => {
    const rows = [item('a', 'x', 'x', 'Report 10'), item('b', 'x', 'x', 'report 9')]
    expect(slugs(sortArtifactList(rows, { field: 'name', direction: 'asc' }, 'en'))).toEqual([
      'b',
      'a'
    ])
  })
})

describe('nextArtifactListSort', () => {
  it('cycles asc → desc → default, and never dead-clicks the default column', () => {
    const asc = nextArtifactListSort(DEFAULT_ARTIFACT_LIST_SORT, 'name')
    const desc = nextArtifactListSort(asc, 'name')
    expect([asc.direction, desc.direction]).toEqual(['asc', 'desc'])
    expect(nextArtifactListSort(desc, 'name')).toEqual(DEFAULT_ARTIFACT_LIST_SORT)
    expect(nextArtifactListSort(DEFAULT_ARTIFACT_LIST_SORT, 'updated')).not.toEqual(
      DEFAULT_ARTIFACT_LIST_SORT
    )
  })
})

describe('filterArtifactList expires', () => {
  const at = (offset: number): string => new Date(NOW + offset).toISOString()
  const rows = [
    item('expired', at(-1), at(-1)),
    item('now', at(0), at(0)),
    item('soon', at(0), at(7 * DAY)),
    item('later', at(0), at(7 * DAY + 1)),
    item('bad', at(0), 'not-a-date')
  ]

  it('splits expired and within-7-days at the boundaries and drops unknown expiry', () => {
    const run = (expires: 'week' | 'expired'): string[] =>
      slugs(filterArtifactList(rows, { ...EMPTY_ARTIFACT_LIST_FILTER, expires }, NOW))
    expect(run('expired')).toEqual(['expired', 'now'])
    expect(run('week')).toEqual(['soon'])
  })
})
