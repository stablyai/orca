import { describe, expect, it } from 'vitest'
import {
  buildLocalWorktreeCreateArgs,
  optionalCreateWorktreeLinkOptions
} from './worktree-create-payload'

describe('worktree create payload linked ClickUp', () => {
  it('forwards linked ClickUp fields through optional link options', () => {
    expect(
      optionalCreateWorktreeLinkOptions({
        linkedClickUpTaskId: '86fixturea',
        linkedClickUpWorkspaceId: 'team-1'
      })
    ).toEqual({
      linkedClickUpTaskId: '86fixturea',
      linkedClickUpWorkspaceId: 'team-1'
    })
  })

  it('includes linked ClickUp fields from options', () => {
    const args = buildLocalWorktreeCreateArgs(
      {
        repoId: 'repo-1',
        name: 'feature',
        setupDecision: 'inherit',
        options: {
          linkedClickUpTaskId: '86fixturea',
          linkedClickUpWorkspaceId: 'team-1'
        }
      },
      { name: 'feature' }
    )
    expect(args).toMatchObject({
      linkedClickUpTaskId: '86fixturea',
      linkedClickUpWorkspaceId: 'team-1'
    })
  })
})
