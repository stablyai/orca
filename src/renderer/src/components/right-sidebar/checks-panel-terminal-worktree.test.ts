import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { resolveChecksPanelWorktreeFromTerminalCwd } from './checks-panel-terminal-worktree'

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: overrides.id ?? `repo-1::${overrides.path ?? '/repo'}`,
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/repo',
    displayName: overrides.displayName ?? 'Repo',
    priorWorktreeIds: overrides.priorWorktreeIds,
    isArchived: overrides.isArchived ?? false
  } as Worktree
}

describe('resolveChecksPanelWorktreeFromTerminalCwd', () => {
  it('matches prior worktree paths after a path-derived id changes', () => {
    const renamed = worktree({
      id: 'repo-1::/new/path',
      path: '/new/path',
      priorWorktreeIds: ['repo-1::/old/path']
    })

    expect(resolveChecksPanelWorktreeFromTerminalCwd('/old/path/src', [renamed])).toBe(renamed)
  })

  it('matches Linux cwd under a WSL UNC worktree path', () => {
    const wsl = worktree({
      id: 'repo-1:://wsl.localhost/Ubuntu/home/me/project',
      path: '//wsl.localhost/Ubuntu/home/me/project'
    })

    expect(resolveChecksPanelWorktreeFromTerminalCwd('/home/me/project/src', [wsl])).toBe(wsl)
  })
})
