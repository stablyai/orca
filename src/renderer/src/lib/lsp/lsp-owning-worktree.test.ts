import { describe, expect, it } from 'vitest'
import { findOwningWorktree } from './lsp-owning-worktree'

const worktrees = [
  { id: 'r1::/code/app', path: '/code/app', repoId: 'r1' },
  { id: 'r1::/code/app/nested', path: '/code/app/nested', repoId: 'r1' },
  { id: 'r2::/code/remote', path: '/code/remote', repoId: 'r2', hostId: 'ssh:box' as const }
]

describe('findOwningWorktree', () => {
  it('picks the deepest local root that contains the file', () => {
    expect(findOwningWorktree(worktrees, '/code/app/nested/a.rb')?.worktreeId).toBe(
      'r1::/code/app/nested'
    )
    expect(findOwningWorktree(worktrees, '/code/app/lib/a.rb')?.worktreeId).toBe('r1::/code/app')
  })

  it('does not match sibling prefixes or remote worktrees', () => {
    expect(findOwningWorktree(worktrees, '/code/app2/a.rb')).toBeNull()
    expect(findOwningWorktree(worktrees, '/code/remote/a.rb')).toBeNull()
  })

  it('compares win32 paths case-insensitively across separators', () => {
    const win = [{ id: 'r::C:\\Code\\App', path: 'C:\\Code\\App', repoId: 'r' }]
    expect(findOwningWorktree(win, 'c:/code/app/x.ts', 'win32')?.worktreeId).toBe(
      'r::C:\\Code\\App'
    )
  })
})
