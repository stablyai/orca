import { describe, expect, it } from 'vitest'
import {
  createAgentScratchWorktreePathMatcher,
  isAgentScratchWorktreePath
} from './agent-scratch-worktrees'

describe('isAgentScratchWorktreePath', () => {
  const repoPath = '/Users/dev/app'

  it('matches scratch worktrees created from a linked checkout', () => {
    const matchesAgentScratch = createAgentScratchWorktreePathMatcher(
      [repoPath, '/Users/dev/orca/workspaces/app/feature-x'],
      []
    )

    expect(
      matchesAgentScratch(
        '/Users/dev/orca/workspaces/app/feature-x/.claude/worktrees/agent-a04ccaaa'
      )
    ).toBe(true)
    expect(matchesAgentScratch('/Users/dev/other/feature-x/.claude/worktrees/agent-a04ccaaa')).toBe(
      false
    )
  })

  it('preserves case-sensitive POSIX and WSL tool segments', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.Claude/Worktrees/agent-a04ccaaa', [])
    ).toBe(false)
    expect(
      isAgentScratchWorktreePath(
        '//wsl.localhost/Ubuntu/home/dev/app',
        '//wsl.localhost/ubuntu/home/dev/app/.Claude/Worktrees/agent-a04ccaaa',
        []
      )
    ).toBe(false)
  })

  it('requires the tool directory at the repo root', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.claude/other/worktrees/agent-1', [])
    ).toBe(false)
    expect(
      isAgentScratchWorktreePath(
        repoPath,
        '/Users/dev/app/packages/demo/.claude/worktrees/agent-1',
        []
      )
    ).toBe(false)
    expect(isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.gsd-workspaces', [])).toBe(false)
  })

  it('does not inherit a scratch classification from the repo parent path', () => {
    expect(
      isAgentScratchWorktreePath(
        '/Users/dev/.claude/worktrees/app',
        '/Users/dev/.claude/worktrees/app/manual/feature-x',
        []
      )
    ).toBe(false)
  })
})
