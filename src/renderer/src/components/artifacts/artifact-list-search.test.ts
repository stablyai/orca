import { describe, expect, it } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import {
  ARTIFACT_LIST_SEARCH_QUERY_MAX_BYTES,
  artifactMatchesSearchQuery,
  clampArtifactListSearchQuery,
  filterArtifactsBySearchQuery
} from './artifact-list-search'

function item(overrides: Partial<ArtifactListItem['artifact']> = {}): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug: 'report-123',
      title: 'Quarterly report',
      originalFileName: 'report.html',
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-02T12:00:00.000Z',
      expiresAt: '2026-09-01T12:00:00.000Z',
      byteSize: 1024,
      deletedAt: null,
      ...overrides
    },
    shareUrl: 'https://share.onorca.dev/a/report-123'
  }
}

describe('artifact list search', () => {
  it('matches title, filename, slug, and type', () => {
    expect(artifactMatchesSearchQuery(item(), 'quarterly')).toBe(true)
    expect(artifactMatchesSearchQuery(item(), 'report.html')).toBe(true)
    expect(artifactMatchesSearchQuery(item(), 'report-123')).toBe(true)
    expect(artifactMatchesSearchQuery(item(), 'html')).toBe(true)
    expect(artifactMatchesSearchQuery(item(), 'markdown')).toBe(false)
  })

  it('treats blank queries as a match', () => {
    expect(artifactMatchesSearchQuery(item(), '   ')).toBe(true)
  })

  it('filters a list without mutating it', () => {
    const items = [
      item(),
      item({ slug: 'notes', title: 'Notes', sourceContentType: 'text/markdown' })
    ]
    const filtered = filterArtifactsBySearchQuery(items, 'notes')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.artifact.slug).toBe('notes')
    expect(items).toHaveLength(2)
  })

  it('leaves the list unfiltered rather than scanning an oversized query', () => {
    const oversized = 'a'.repeat(ARTIFACT_LIST_SEARCH_QUERY_MAX_BYTES + 1)
    const items = [item()]

    expect(filterArtifactsBySearchQuery(items, oversized)).toBe(items)
    expect(artifactMatchesSearchQuery(item(), oversized)).toBe(true)
  })

  it('clamps a multi-MB paste before it reaches state', () => {
    const paste = 'x'.repeat(4 * 1024 * 1024)

    expect(clampArtifactListSearchQuery(paste)).toHaveLength(
      ARTIFACT_LIST_SEARCH_QUERY_MAX_BYTES + 1
    )
    expect(clampArtifactListSearchQuery('short')).toBe('short')
  })
})
