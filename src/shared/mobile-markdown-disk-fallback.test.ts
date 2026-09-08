import { describe, expect, it } from 'vitest'
import { buildMarkdownDiskFallbackDoc } from './mobile-markdown-disk-fallback'

describe('buildMarkdownDiskFallbackDoc', () => {
  it('builds a read-only markdown document from disk content', () => {
    expect(
      buildMarkdownDiskFallbackDoc({
        content: '# Notes',
        truncated: false,
        tabIsDirty: false
      })
    ).toEqual({
      status: 'ready',
      content: '# Notes',
      localContent: '# Notes',
      baseVersion: '',
      isDirty: false,
      editable: false,
      stale: false,
      readOnlyReason: 'Editing needs Orca desktop running.'
    })
  })

  it('marks disk content stale when the desktop tab has unsaved changes', () => {
    expect(
      buildMarkdownDiskFallbackDoc({
        content: '# Notes',
        truncated: false,
        tabIsDirty: true
      })
    ).toMatchObject({
      editable: false,
      stale: true,
      readOnlyReason: 'Desktop has unsaved changes. Showing disk content.'
    })
  })

  it('warns when the disk read is truncated', () => {
    expect(
      buildMarkdownDiskFallbackDoc({
        content: '# Partial',
        truncated: true,
        tabIsDirty: true
      })
    ).toMatchObject({
      editable: false,
      stale: true,
      readOnlyReason: 'File too large for mobile preview'
    })
  })
})
