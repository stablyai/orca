import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import {
  artifactTypeLabel,
  formatArtifactExpiryCompact,
  formatArtifactUpdatedCompact
} from './artifact-display-labels'

function item(sourceContentType: string): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug: 'doc',
      title: 'Doc',
      originalFileName: 'doc.md',
      sourceContentType,
      renderedContentType: 'text/html',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-02T12:00:00.000Z',
      expiresAt: '2026-09-01T12:00:00.000Z',
      byteSize: 1,
      deletedAt: null
    },
    shareUrl: 'https://share.onorca.dev/a/doc'
  }
}

describe('artifact display labels', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('labels known artifact types', () => {
    expect(artifactTypeLabel(item('text/html'))).toBe('HTML')
    expect(artifactTypeLabel(item('text/markdown'))).toBe('Markdown')
    expect(artifactTypeLabel(item('application/pdf'))).toBe('application/pdf')
  })

  it('uses compact relative times for table cells', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'))
    expect(formatArtifactUpdatedCompact('2026-08-08T12:00:00.000Z')).toBe('2 days ago')
    expect(formatArtifactUpdatedCompact('not-a-date')).toBe('recently')
    expect(formatArtifactExpiryCompact('2026-08-20T12:00:00.000Z')).toBe('in 10 days')
    expect(formatArtifactExpiryCompact('2026-08-01T12:00:00.000Z')).toBe('Expired')
    expect(formatArtifactExpiryCompact('not-a-date')).toBe('Expiry unknown')
  })
})
