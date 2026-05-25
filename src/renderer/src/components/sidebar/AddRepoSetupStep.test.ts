import { describe, expect, it } from 'vitest'
import {
  getInitialProjectAddedChoice,
  getInitialProjectAddedWorktreeName
} from './AddRepoSetupStep'

describe('getInitialProjectAddedWorktreeName', () => {
  it('fills the project-added setup input with a default workspace name', () => {
    expect(getInitialProjectAddedWorktreeName(undefined)).toBe('new-workspace-1')
    expect(getInitialProjectAddedWorktreeName('')).toBe('new-workspace-1')
    expect(getInitialProjectAddedWorktreeName('   ')).toBe('new-workspace-1')
  })

  it('preserves caller-provided defaults', () => {
    expect(getInitialProjectAddedWorktreeName('orca-worktree-1')).toBe('orca-worktree-1')
  })
})

describe('getInitialProjectAddedChoice', () => {
  it('defaults to creating a worktree when Orca found linked worktrees', () => {
    expect(getInitialProjectAddedChoice(1)).toBe('create')
  })

  it('defaults to creating a worktree when no linked worktrees were found', () => {
    expect(getInitialProjectAddedChoice(0)).toBe('create')
  })
})
