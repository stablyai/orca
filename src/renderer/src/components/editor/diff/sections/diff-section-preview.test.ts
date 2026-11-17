import { describe, expect, it } from 'vitest'
import { diffSectionPreviewTarget } from './diff-section-preview'

function target(
  path: string,
  overrides: Partial<Parameters<typeof diffSectionPreviewTarget>[0]> = {}
): ReturnType<typeof diffSectionPreviewTarget> {
  return diffSectionPreviewTarget({
    path,
    status: 'modified',
    isCommitSurface: false,
    canOpenWorkspaceFileBrowser: true,
    ...overrides
  })
}

describe('diffSectionPreviewTarget', () => {
  it.each(['a.html', 'a.htm', 'a.jsp', 'a.jspf'])('previews %s as a page', (path) => {
    expect(target(path)).toBe('orca-browser')
    expect(target(path, { canOpenWorkspaceFileBrowser: false })).toBeNull()
  })

  it.each(['notes.md', 'page.mdx'])('renders %s without needing a browser', (path) => {
    expect(target(path)).toBe('markdown-preview')
    expect(target(path, { canOpenWorkspaceFileBrowser: false })).toBe('markdown-preview')
  })

  it('offers nothing for other files, deleted entries or commit snapshots', () => {
    expect(target('app.ts')).toBeNull()
    expect(target('a.html', { status: 'deleted' })).toBeNull()
    expect(target('notes.md', { status: 'deleted' })).toBeNull()
    expect(target('a.html', { isCommitSurface: true })).toBeNull()
    expect(target('notes.md', { isCommitSurface: true })).toBeNull()
  })
})
