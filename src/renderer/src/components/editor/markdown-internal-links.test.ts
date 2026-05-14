import { describe, expect, it } from 'vitest'
import { resolveMarkdownLinkTarget } from './markdown-internal-links'

// Tests run under happy-dom or similar; navigator.userAgent reflects the
// test runner. The isDescendantOf containment check is therefore
// case-insensitive on macOS/Windows runners and case-sensitive on Linux.
// Most tests avoid case-differences so they pass on either host.

const SOURCE = '/repo/docs/note.md'
const ROOT = '/repo'

describe('resolveMarkdownLinkTarget', () => {
  it('classifies relative .md inside worktree as markdown', () => {
    const r = resolveMarkdownLinkTarget('./guide.md', SOURCE, ROOT)
    expect(r).toEqual({
      kind: 'markdown',
      absolutePath: '/repo/docs/guide.md',
      relativePath: 'docs/guide.md'
    })
  })

  it('classifies relative .md outside worktree as file', () => {
    const r = resolveMarkdownLinkTarget('../../other/guide.md', SOURCE, ROOT)
    expect(r?.kind).toBe('file')
  })

  it('classifies absolute .md inside worktree as markdown', () => {
    const r = resolveMarkdownLinkTarget('/repo/docs/guide.md', SOURCE, ROOT)
    expect(r?.kind).toBe('markdown')
  })

  it('extracts line from #L10', () => {
    const r = resolveMarkdownLinkTarget('./guide.md#L10', SOURCE, ROOT)
    expect(r).toMatchObject({ kind: 'markdown', line: 10, column: undefined })
  })

  it('extracts line+col from #L10C5', () => {
    const r = resolveMarkdownLinkTarget('./guide.md#L10C5', SOURCE, ROOT)
    expect(r).toMatchObject({ kind: 'markdown', line: 10, column: 5 })
  })

  it('extracts line+col from trailing :10:5 syntax', () => {
    const r = resolveMarkdownLinkTarget('./guide.md:10:5', SOURCE, ROOT)
    expect(r).toMatchObject({ kind: 'markdown', line: 10, column: 5 })
  })

  it('ignores non-line-col hashes', () => {
    const r = resolveMarkdownLinkTarget('./guide.md#intro', SOURCE, ROOT)
    expect(r).toMatchObject({ kind: 'markdown', line: undefined, column: undefined })
  })

  it('does not treat :note in a filename as a line anchor', () => {
    const r = resolveMarkdownLinkTarget('./my:note.md', SOURCE, ROOT)
    expect(r).toMatchObject({ kind: 'markdown', line: undefined })
    expect((r as { absolutePath: string }).absolutePath).toContain('my:note.md')
  })

  it('does not treat a mid-name colon with digits as a line anchor', () => {
    const r = resolveMarkdownLinkTarget('./weird:12name.md', SOURCE, ROOT)
    expect(r).toMatchObject({ kind: 'markdown', line: undefined })
  })

  it('classifies http(s) as external', () => {
    const r = resolveMarkdownLinkTarget('https://example.com', SOURCE, ROOT)
    expect(r).toEqual({ kind: 'external', url: 'https://example.com/' })
  })

  it('classifies bare anchor as anchor', () => {
    const r = resolveMarkdownLinkTarget('#heading-only', SOURCE, ROOT)
    expect(r).toEqual({ kind: 'anchor' })
  })

  it('classifies non-markdown local file as file', () => {
    const r = resolveMarkdownLinkTarget('./image.png', SOURCE, ROOT)
    expect(r).toMatchObject({
      kind: 'file',
      absolutePath: '/repo/docs/image.png',
      relativePath: 'docs/image.png'
    })
  })

  it('classifies explicit file URLs inside the worktree with a relative path', () => {
    const r = resolveMarkdownLinkTarget('file:///repo/docs/image.png', SOURCE, ROOT)
    expect(r).toMatchObject({
      kind: 'file',
      uri: 'file:///repo/docs/image.png',
      absolutePath: '/repo/docs/image.png',
      relativePath: 'docs/image.png'
    })
  })

  it('classifies explicit file URLs outside the worktree without a relative path', () => {
    const r = resolveMarkdownLinkTarget('file:///tmp/image.png', SOURCE, ROOT)
    expect(r).toMatchObject({
      kind: 'file',
      uri: 'file:///tmp/image.png',
      absolutePath: '/tmp/image.png',
      relativePath: undefined
    })
  })

  it('never returns markdown when worktreeRoot is null', () => {
    const r = resolveMarkdownLinkTarget('./guide.md', SOURCE, null)
    expect(r?.kind).toBe('file')
  })

  it('decodes URL-encoded spaces in the path', () => {
    const r = resolveMarkdownLinkTarget('./my%20note.md', SOURCE, ROOT)
    expect(r).toMatchObject({
      kind: 'markdown',
      absolutePath: '/repo/docs/my note.md'
    })
  })

  it('returns null for empty href', () => {
    expect(resolveMarkdownLinkTarget('', SOURCE, ROOT)).toBeNull()
    expect(resolveMarkdownLinkTarget(undefined, SOURCE, ROOT)).toBeNull()
  })
})
