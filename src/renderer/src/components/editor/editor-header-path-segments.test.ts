import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  canNavigateEditorHeaderPath,
  getEditorHeaderPathOpenKind,
  getEditorHeaderPathPreviewSuffix,
  getEditorHeaderPathSegments,
  isEditorHeaderPathCurrentEntry,
  resolveEditorHeaderDirectoryAbsolutePath
} from './editor-header-path-segments'

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/src/lib/path.ts',
    filePath: '/repo/src/lib/path.ts',
    relativePath: 'src/lib/path.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('canNavigateEditorHeaderPath', () => {
  it('allows real file tabs and rejects virtual tabs', () => {
    expect(canNavigateEditorHeaderPath(makeOpenFile({ mode: 'edit' }))).toBe(true)
    expect(canNavigateEditorHeaderPath(makeOpenFile({ mode: 'markdown-preview' }))).toBe(true)
    expect(canNavigateEditorHeaderPath(makeOpenFile({ mode: 'diff' }))).toBe(false)
    expect(canNavigateEditorHeaderPath(makeOpenFile({ mode: 'conflict-review' }))).toBe(false)
    expect(canNavigateEditorHeaderPath(makeOpenFile({ mode: 'check-details' }))).toBe(false)
  })

  it('keeps absolute relative paths static across runtime path flavors', () => {
    expect(canNavigateEditorHeaderPath(makeOpenFile({ relativePath: '/outside/file.ts' }))).toBe(
      false
    )
    expect(
      canNavigateEditorHeaderPath(makeOpenFile({ relativePath: 'C:\\outside\\file.ts' }))
    ).toBe(false)
    expect(
      canNavigateEditorHeaderPath(makeOpenFile({ relativePath: '\\\\server\\share\\file.ts' }))
    ).toBe(false)
  })
})

describe('getEditorHeaderPathSegments', () => {
  it('splits posix worktree-relative paths and lists the file parent for the filename', () => {
    const segments = getEditorHeaderPathSegments(makeOpenFile())
    expect(segments).toEqual([
      { id: 'src', label: 'src', relativeDirectoryPath: 'src', isFile: false },
      { id: 'src/lib', label: 'lib', relativeDirectoryPath: 'src/lib', isFile: false },
      { id: 'src/lib/path.ts', label: 'path.ts', relativeDirectoryPath: 'src/lib', isFile: true }
    ])
  })

  it('splits Windows worktree-relative paths', () => {
    const segments = getEditorHeaderPathSegments(
      makeOpenFile({
        filePath: 'C:\\repo\\src\\lib\\path.ts',
        relativePath: 'src\\lib\\path.ts'
      })
    )
    expect(segments?.map((segment) => segment.label)).toEqual(['src', 'lib', 'path.ts'])
    expect(segments?.[2]).toMatchObject({
      label: 'path.ts',
      relativeDirectoryPath: 'src/lib',
      isFile: true
    })
  })

  it('keeps a root file as a single segment that lists the worktree root', () => {
    expect(
      getEditorHeaderPathSegments(
        makeOpenFile({ relativePath: 'README.md', filePath: '/repo/README.md' })
      )
    ).toEqual([{ id: 'README.md', label: 'README.md', relativeDirectoryPath: '', isFile: true }])
  })

  it('does not turn the preview suffix into a path segment', () => {
    const file = makeOpenFile({
      id: 'markdown-preview::/repo/docs/README.md',
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      language: 'markdown',
      mode: 'markdown-preview'
    })
    const segments = getEditorHeaderPathSegments(file)
    expect(segments?.map((segment) => segment.label)).toEqual(['docs', 'README.md'])
    expect(getEditorHeaderPathPreviewSuffix(file)).toBe(' (preview)')
    expect(segments?.some((segment) => segment.label.includes('preview'))).toBe(false)
  })

  it('returns no segments for virtual tabs', () => {
    expect(getEditorHeaderPathSegments(makeOpenFile({ mode: 'diff' }))).toBeNull()
    expect(getEditorHeaderPathSegments(makeOpenFile({ mode: 'conflict-review' }))).toBeNull()
    expect(getEditorHeaderPathSegments(makeOpenFile({ mode: 'check-details' }))).toBeNull()
  })
})

describe('resolveEditorHeaderDirectoryAbsolutePath', () => {
  it('joins posix and Windows worktree roots', () => {
    const file = makeOpenFile()
    expect(resolveEditorHeaderDirectoryAbsolutePath(file, '/repo', 'src/lib')).toBe('/repo/src/lib')
    expect(resolveEditorHeaderDirectoryAbsolutePath(file, '/repo', '')).toBe('/repo')
    expect(
      resolveEditorHeaderDirectoryAbsolutePath(
        makeOpenFile({
          filePath: 'C:\\repo\\src\\lib\\path.ts',
          relativePath: 'src\\lib\\path.ts'
        }),
        'C:\\repo',
        'src/lib'
      )
    ).toBe('C:\\repo\\src\\lib')
  })

  it('uses a folder workspace root the same way as a git worktree root', () => {
    expect(
      resolveEditorHeaderDirectoryAbsolutePath(
        makeOpenFile({
          worktreeId: 'folder::notes',
          filePath: '/Users/me/notes/docs/todo.md',
          relativePath: 'docs/todo.md'
        }),
        '/Users/me/notes',
        'docs'
      )
    ).toBe('/Users/me/notes/docs')
  })
})

describe('isEditorHeaderPathCurrentEntry', () => {
  it('matches the current file across Windows path flavors', () => {
    expect(
      isEditorHeaderPathCurrentEntry('/repo/src/lib', 'path.ts', '/repo/src/lib/path.ts')
    ).toBe(true)
    expect(
      isEditorHeaderPathCurrentEntry('C:\\repo\\src\\lib', 'path.ts', 'C:\\repo\\src\\lib\\path.ts')
    ).toBe(true)
    expect(
      isEditorHeaderPathCurrentEntry('/repo/src/lib', 'other.ts', '/repo/src/lib/path.ts')
    ).toBe(false)
  })
})

describe('getEditorHeaderPathOpenKind', () => {
  it('keeps markdown preview only when the current tab is already a preview of markdown', () => {
    expect(getEditorHeaderPathOpenKind('markdown-preview', 'markdown')).toBe('markdown-preview')
    expect(getEditorHeaderPathOpenKind('markdown-preview', 'typescript')).toBe('edit')
    expect(getEditorHeaderPathOpenKind('edit', 'markdown')).toBe('edit')
  })
})
