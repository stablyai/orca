import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

import { findWorkspaceShowingFile } from './plugin-view-editor-workspace'

const worktree = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  path,
  isArchived: false,
  ...extra
})

describe('the workspace that shows a file', () => {
  it('matches the real path when the given one goes through a symlink, preferring the deepest', () => {
    const repos = {
      r1: [worktree('r1::/private/tmp', '/private/tmp')],
      r2: [worktree('r2::/private/tmp/sketch', '/private/tmp/sketch')]
    }
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
    const repos = {
      r1: [
        worktree('r1::/w', '/w', { hostId: 'ssh:box' }),
        worktree('r1::/w2', '/w', { isArchived: true })
      ]
    }
    expect(findWorkspaceShowingFile(repos, ['/w/a.sketch'], null)).toBeNull()
    expect(findWorkspaceShowingFile({}, ['/w/a.sketch'], null)).toBeNull()
  })

  it('prefers the active workspace among equally deep ones', () => {
    const repos = { r1: [worktree('a', '/w')], r2: [worktree('b', '/w')] }
    expect(findWorkspaceShowingFile(repos, ['/w/a.sketch'], 'b')?.worktreeId).toBe('b')
  })
})
