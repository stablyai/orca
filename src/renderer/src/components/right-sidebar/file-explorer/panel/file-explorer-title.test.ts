import { describe, expect, it } from 'vitest'
import { getFileExplorerTitle } from './file-explorer-title'

const git = { displayName: 'orca', kind: 'git' as const }

describe('getFileExplorerTitle', () => {
  it('names the worktree a git project shows', () => {
    expect(
      getFileExplorerTitle(git, { displayName: '', branch: 'refs/heads/fix-login', path: '/w/a' })
    ).toEqual({ repoName: 'orca', worktreeName: 'fix-login' })
    expect(
      getFileExplorerTitle(git, { displayName: 'Login fix', branch: 'fix-login', path: '/w/a' })
    ).toEqual({ repoName: 'orca', worktreeName: 'Login fix' })
  })

  it('shows only the project for folders and names that repeat it', () => {
    expect(
      getFileExplorerTitle(
        { displayName: 'notes', kind: 'folder' },
        { displayName: 'notes', branch: '', path: '/notes' }
      )
    ).toEqual({ repoName: 'notes', worktreeName: null })
    expect(
      getFileExplorerTitle(git, { displayName: 'orca', branch: 'main', path: '/w/orca' })
    ).toEqual({ repoName: 'orca', worktreeName: null })
  })
})
