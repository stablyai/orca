import { describe, expect, it } from 'vitest'
import { resolveMarkdownLinkTarget } from './markdown-internal-links'

// Path containment follows the runner platform’s case rules; fixtures avoid case differences for portability.

const SOURCE = '/repo/docs/note.md'
const ROOT = '/repo'

describe('resolveMarkdownLinkTarget', () => {
  it('classifies relative .md inside a UNC worktree as markdown', () => {
    const r = resolveMarkdownLinkTarget(
      './guide.md',
      '\\\\server\\share\\repo\\docs\\note.md',
      '\\\\server\\share\\repo'
    )
    expect(r).toEqual({
      kind: 'markdown',
      absolutePath: '//server/share/repo/docs/guide.md',
      relativePath: 'docs/guide.md'
    })
  })

  it('extracts hash line anchors from Windows drive-letter absolute .md links', () => {
    const r = resolveMarkdownLinkTarget(
      'C:\\repo\\docs\\guide.md#L10',
      'C:\\repo\\docs\\note.md',
      'C:\\repo'
    )
    expect(r).toMatchObject({
      kind: 'markdown',
      absolutePath: 'C:/repo/docs/guide.md',
      relativePath: 'docs/guide.md',
      line: 10
    })
  })

  it('extracts line+col from non-markdown file links', () => {
    const r = resolveMarkdownLinkTarget('../src/PdfViewer.tsx:142:7', SOURCE, ROOT)
    expect(r).toMatchObject({
      kind: 'file',
      absolutePath: '/repo/src/PdfViewer.tsx',
      relativePath: 'src/PdfViewer.tsx',
      line: 142,
      column: 7
    })
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

  it('classifies explicit UNC file URLs without losing the server name', () => {
    const r = resolveMarkdownLinkTarget(
      'file://server/share/repo/docs/image.png',
      '\\\\server\\share\\repo\\docs\\note.md',
      '\\\\server\\share\\repo'
    )
    expect(r).toMatchObject({
      kind: 'file',
      uri: 'file://server/share/repo/docs/image.png',
      absolutePath: '//server/share/repo/docs/image.png',
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

  it('returns null for malformed percent-encoded file URL paths', () => {
    expect(resolveMarkdownLinkTarget('file:///repo/docs/%zz.md', SOURCE, ROOT)).toBeNull()
  })
})
