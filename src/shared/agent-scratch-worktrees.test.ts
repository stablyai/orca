import { describe, expect, it } from 'vitest'
import {
  createAgentScratchWorktreePathMatcher,
  isAgentScratchWorktreePath
} from './agent-scratch-worktrees'

describe('isAgentScratchWorktreePath', () => {
  const repoPath = '/Users/dev/app'

  it('matches Claude Code sub-agent worktrees', () => {
    expect(
      isAgentScratchWorktreePath(
        repoPath,
        '/Users/dev/app/.claude/worktrees/agent-a04ccaaa55ddadb91'
      )
    ).toBe(true)
  })

  it('matches gsd parallel-agent workspaces', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.gsd-workspaces/phase-1-subagent-2')
    ).toBe(true)
  })

  it('matches scratch worktrees created from a linked checkout', () => {
    const matchesAgentScratch = createAgentScratchWorktreePathMatcher([
      repoPath,
      '/Users/dev/orca/workspaces/app/feature-x'
    ])

    expect(
      matchesAgentScratch(
        '/Users/dev/orca/workspaces/app/feature-x/.claude/worktrees/agent-a04ccaaa'
      )
    ).toBe(true)
    expect(matchesAgentScratch('/Users/dev/other/feature-x/.claude/worktrees/agent-a04ccaaa')).toBe(
      false
    )
  })

  it('matches Windows path separators and casing', () => {
    expect(
      isAgentScratchWorktreePath(
        'C:\\Users\\dev\\app',
        'c:\\USERS\\dev\\app\\.Claude\\Worktrees\\agent-a04ccaaa'
      )
    ).toBe(true)
  })

  it('matches WSL UNC paths', () => {
    expect(
      isAgentScratchWorktreePath(
        '//wsl$/Ubuntu/home/dev/app',
        '//wsl.localhost/Ubuntu/home/dev/app/.claude/worktrees/agent-a04ccaaa'
      )
    ).toBe(true)
  })

  it('preserves case-sensitive POSIX and WSL tool segments', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.Claude/Worktrees/agent-a04ccaaa')
    ).toBe(false)
    expect(
      isAgentScratchWorktreePath(
        '//wsl.localhost/Ubuntu/home/dev/app',
        '//wsl.localhost/ubuntu/home/dev/app/.Claude/Worktrees/agent-a04ccaaa'
      )
    ).toBe(false)
  })

  it('requires the tool directory at the repo root', () => {
    expect(
      isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.claude/other/worktrees/agent-1')
    ).toBe(false)
    expect(
      isAgentScratchWorktreePath(repoPath, '/Users/dev/app/packages/demo/.claude/worktrees/agent-1')
    ).toBe(false)
    expect(isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.gsd-workspaces')).toBe(false)
  })

  it('does not match undotted claude directories', () => {
    expect(isAgentScratchWorktreePath(repoPath, '/Users/dev/app/claude/worktrees/agent-1')).toBe(
      false
    )
  })

  it('does not inherit a scratch classification from the repo parent path', () => {
    expect(
      isAgentScratchWorktreePath(
        '/Users/dev/.claude/worktrees/app',
        '/Users/dev/.claude/worktrees/app/manual/feature-x'
      )
    ).toBe(false)
  })

  it('does not match user worktree conventions', () => {
    expect(isAgentScratchWorktreePath(repoPath, '/Users/dev/app/.worktrees/feature-x')).toBe(false)
    expect(
      isAgentScratchWorktreePath('/Users/dev/app', '/Users/dev/.superset/worktrees/app/fix-notes')
    ).toBe(false)
    expect(isAgentScratchWorktreePath('/Users/dev/app', '/orca/workspaces/app/feature')).toBe(false)
  })
})
