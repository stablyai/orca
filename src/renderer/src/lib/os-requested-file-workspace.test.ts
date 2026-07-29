import { describe, expect, it } from 'vitest'
import { findWorkspaceForFilePath } from './os-requested-file-workspace'

describe('findWorkspaceForFilePath', () => {
  it('returns null when no workspace contains the file', () => {
    expect(
      findWorkspaceForFilePath('/Users/x/Downloads/note.md', [
        { id: 'w1', path: '/Users/x/projects/orca' }
      ])
    ).toBeNull()
  })

  it('matches a containing workspace and reports the relative path', () => {
    expect(
      findWorkspaceForFilePath('/Users/x/projects/orca/docs/note.md', [
        { id: 'w1', path: '/Users/x/projects/orca' }
      ])
    ).toEqual({
      workspace: { id: 'w1', path: '/Users/x/projects/orca' },
      relativePath: 'docs/note.md'
    })
  })

  it('prefers the deepest workspace when several contain the file', () => {
    const result = findWorkspaceForFilePath('/Users/x/projects/orca/sub/note.md', [
      { id: 'outer', path: '/Users/x/projects' },
      { id: 'inner', path: '/Users/x/projects/orca' }
    ])
    expect(result?.workspace.id).toBe('inner')
    expect(result?.relativePath).toBe('sub/note.md')
  })

  it('does not match a sibling directory that shares a name prefix', () => {
    expect(
      findWorkspaceForFilePath('/Users/x/projects/orca-extra/note.md', [
        { id: 'w1', path: '/Users/x/projects/orca' }
      ])
    ).toBeNull()
  })

  it('ignores candidates with an empty path', () => {
    expect(
      findWorkspaceForFilePath('/Users/x/Downloads/note.md', [{ id: 'w1', path: '' }])
    ).toBeNull()
  })

  it('matches a file sitting directly in the workspace root', () => {
    expect(
      findWorkspaceForFilePath('/Users/x/Downloads/note.md', [
        { id: 'dl', path: '/Users/x/Downloads' }
      ])?.relativePath
    ).toBe('note.md')
  })

  it('prefers deepest workspace even when ancestor path is longer due to Unicode encoding', () => {
    // Why: roots in different Unicode forms (NFD vs NFC) can have different .length despite same meaning.
    // Ancestor: 'éééééée' in NFD form (13 code units vs 7 in NFC)
    const nfdDirName = 'éééééée'.normalize('NFD') // 13 units
    const ancestorRoot = `/workspace/${nfdDirName}` // 11 + 13 = 24 units
    // Descendant: same directory name in NFC form plus short segment
    const ncfDirName = 'éééééée'.normalize('NFC') // 7 units
    const descendantRoot = `/workspace/${ncfDirName}/x` // 11 + 7 + 2 = 20 units
    const filePath = `${descendantRoot}/file.md`

    // With old comparison (workspace.path.length > best.path.length):
    //   ancestor: 24 > descendant: 20 → ancestor wins (WRONG — it's shallower)
    // With new comparison (relativePath.length < best.relativePath.length):
    //   ancestor relative: 'x/file.md' (9) > descendant relative: 'file.md' (7) → descendant wins (correct)
    const result = findWorkspaceForFilePath(filePath, [
      { id: 'ancestor', path: ancestorRoot },
      { id: 'descendant', path: descendantRoot }
    ])
    expect(result?.workspace.id).toBe('descendant')
    expect(result?.relativePath).toBe('file.md')
  })

  it('matches when file path exactly equals workspace root and returns empty relative path', () => {
    const result = findWorkspaceForFilePath('/Users/x/Downloads', [
      { id: 'dl', path: '/Users/x/Downloads' }
    ])
    expect(result).toEqual({
      workspace: { id: 'dl', path: '/Users/x/Downloads' },
      relativePath: ''
    })
  })
})
