import { describe, expect, it } from 'vitest'
import {
  getInitialProjectAddedChoice,
  getInitialProjectAddedWorktreeName,
  getProjectAddedChoiceOrder,
  getProjectAddedPrimaryBranchName,
  getSyncedProjectAddedChoice
} from './AddRepoSetupStep'

describe('getInitialProjectAddedWorktreeName', () => {
  it('fills the project-added setup input with a default worktree name', () => {
    expect(getInitialProjectAddedWorktreeName(undefined)).toBe('new-worktree-1')
    expect(getInitialProjectAddedWorktreeName('')).toBe('new-worktree-1')
    expect(getInitialProjectAddedWorktreeName('   ')).toBe('new-worktree-1')
  })

  it('preserves caller-provided defaults', () => {
    expect(getInitialProjectAddedWorktreeName('orca-worktree-1')).toBe('orca-worktree-1')
  })
})

describe('getInitialProjectAddedChoice', () => {
  it('defaults to using existing worktrees when Orca found fewer than 10 linked worktrees', () => {
    expect(getInitialProjectAddedChoice(1)).toBe('existing')
    expect(getInitialProjectAddedChoice(9)).toBe('existing')
  })

  it('defaults to creating a worktree when no linked worktrees were found', () => {
    expect(getInitialProjectAddedChoice(0)).toBe('create')
  })

  it('defaults to creating a worktree when Orca found 10 or more linked worktrees', () => {
    expect(getInitialProjectAddedChoice(10)).toBe('create')
    expect(getInitialProjectAddedChoice(11)).toBe('create')
  })

  it('keeps the discovered-worktree threshold when the repo has a named primary branch', () => {
    expect(getInitialProjectAddedChoice(0, 'main')).toBe('create')
    expect(getInitialProjectAddedChoice(2, 'main')).toBe('existing')
    expect(getInitialProjectAddedChoice(10, 'main')).toBe('create')
  })
})

describe('getSyncedProjectAddedChoice', () => {
  it('updates the default choice when worktree detection arrives later', () => {
    expect(getSyncedProjectAddedChoice('create', false, 2)).toBe('existing')
    expect(getSyncedProjectAddedChoice('existing', false, 10)).toBe('create')
  })

  it('preserves a manual selection when worktree detection changes', () => {
    expect(getSyncedProjectAddedChoice('create', true, 2)).toBe('create')
    expect(getSyncedProjectAddedChoice('existing', true, 10)).toBe('existing')
  })
})

describe('getProjectAddedChoiceOrder', () => {
  it('shows the primary checkout before worktree choices', () => {
    expect(getProjectAddedChoiceOrder(2, 'main')).toEqual(['primary', 'existing', 'create'])
  })

  it('omits unavailable choices', () => {
    expect(getProjectAddedChoiceOrder(0, '')).toEqual(['create'])
    expect(getProjectAddedChoiceOrder(1, '')).toEqual(['existing', 'create'])
    expect(getProjectAddedChoiceOrder(0, 'main')).toEqual(['primary', 'create'])
  })
})

describe('getProjectAddedPrimaryBranchName', () => {
  it('formats refs/heads branch names for the setup choice', () => {
    expect(getProjectAddedPrimaryBranchName({ branch: 'refs/heads/main' })).toBe('main')
    expect(getProjectAddedPrimaryBranchName({ branch: 'trunk' })).toBe('trunk')
  })

  it('returns an empty name for detached or missing primary worktrees', () => {
    expect(getProjectAddedPrimaryBranchName({ branch: '' })).toBe('')
    expect(getProjectAddedPrimaryBranchName(null)).toBe('')
  })
})
