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
})
