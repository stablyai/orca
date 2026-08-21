import { describe, expect, it } from 'vitest'
import { isPaletteCurrentWorktree, resolvePaletteRepoForWorktree } from './palette-repo-resolution'

describe('palette repo and current-worktree resolution', () => {
  const local = { id: 'repo-1', displayName: 'Local repo' }
  const remote = { id: 'repo-1', displayName: 'Remote repo' }
  const worktree = { id: 'repo-1::/checkout', repoId: 'repo-1', hostId: 'ssh:box' as const }

  it('uses the host-qualified repo for a colliding worktree', () => {
    expect(
      resolvePaletteRepoForWorktree(
        worktree,
        new Map([['repo-1', local]]),
        new Map([['ssh:box\u0000repo-1', remote]])
      )
    ).toBe(remote)
  })

  it('does not mark a same-id worktree on another host current', () => {
    expect(isPaletteCurrentWorktree(worktree, worktree.id, 'local')).toBe(false)
    expect(isPaletteCurrentWorktree(worktree, worktree.id, 'ssh:box')).toBe(true)
  })
})
