import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

import { findWorkspaceShowingFile, folderWorkspaceRows } from './plugin-view-editor-workspace'

const worktree = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  path,
  isArchived: false,
  ...extra
})

describe('the workspace that shows a file', () => {
  it('matches the real path when the given one goes through a symlink, preferring the deepest', () => {
    const repos = [
      worktree('r1::/private/tmp', '/private/tmp'),
      worktree('r2::/private/tmp/sketch', '/private/tmp/sketch')
    ]
    expect(
      findWorkspaceShowingFile(
        repos,
        ['/tmp/sketch/sample.sketch', '/private/tmp/sketch/sample.sketch'],
        null
      )
    ).toEqual({
      worktreeId: 'r2::/private/tmp/sketch',
      relativePath: 'sample.sketch',
      filePath: '/private/tmp/sketch/sample.sketch'
    })
  })

  it('skips remote and archived workspaces, and finds none outside every workspace', () => {
    const repos = [
      worktree('r1::/w', '/w', { hostId: 'ssh:box' }),
      worktree('r1::/w2', '/w', { isArchived: true })
    ]
    expect(findWorkspaceShowingFile(repos, ['/w/a.sketch'], null)).toBeNull()
    expect(findWorkspaceShowingFile([], ['/w/a.sketch'], null)).toBeNull()
  })

  it('prefers the active workspace among equally deep ones', () => {
    const repos = [worktree('a', '/w'), worktree('b', '/w')]
    expect(findWorkspaceShowingFile(repos, ['/w/a.sketch'], 'b')?.worktreeId).toBe('b')
  })

  it('finds a local folder workspace by its tab key, never a remote one', () => {
    const folder = (id: string, folderPath: string, connectionId: string | null) => ({
      id,
      folderPath,
      connectionId,
      isArchived: false
    })
    const rows = folderWorkspaceRows([folder('f1', '/notes', null), folder('f2', '/notes', 'box')])
    expect(findWorkspaceShowingFile(rows, ['/notes/a.sketch'], null)).toEqual({
      worktreeId: 'folder:f1',
      relativePath: 'a.sketch',
      filePath: '/notes/a.sketch'
    })
  })
})
