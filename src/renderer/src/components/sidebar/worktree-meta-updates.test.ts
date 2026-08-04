import { describe, expect, it } from 'vitest'
import { buildWorktreeMetaUpdates } from './worktree-meta-updates'

describe('buildWorktreeMetaUpdates', () => {
  it('rejects issue URLs in the PR input', () => {
    expect(
      buildWorktreeMetaUpdates({
        displayNameInput: 'Workspace',
        currentDisplayName: 'Workspace',
        issueInput: '',
        prInput: 'https://github.com/stablyai/orca/issues/6933',
        commentInput: ''
      })
    ).toEqual({
      comment: '',
      linkedIssue: null
    })
  })

  it('accepts PR URLs in the PR input', () => {
    expect(
      buildWorktreeMetaUpdates({
        displayNameInput: 'Workspace',
        currentDisplayName: 'Workspace',
        issueInput: '',
        prInput: 'https://github.com/stablyai/orca/pull/6934',
        commentInput: ''
      })
    ).toEqual({
      comment: '',
      linkedIssue: null,
      linkedPR: 6934
    })
  })

  it('accepts issue URLs in the issue input', () => {
    expect(
      buildWorktreeMetaUpdates({
        displayNameInput: 'Workspace',
        currentDisplayName: 'Workspace',
        issueInput: 'https://github.com/stablyai/orca/issues/6933',
        prInput: '',
        commentInput: ''
      })
    ).toEqual({
      comment: '',
      linkedIssue: 6933,
      linkedPR: null
    })
  })

  it('clears a display name with empty string, never a present-undefined key', () => {
    const updates = buildWorktreeMetaUpdates({
      displayNameInput: '   ',
      currentDisplayName: 'Custom Name',
      issueInput: '',
      prInput: '',
      commentInput: ''
    })

    expect(updates.displayName).toBe('')
    expect(Object.values(updates).every((value) => value !== undefined)).toBe(true)
  })

  it('rejects PR URLs in the issue input', () => {
    expect(
      buildWorktreeMetaUpdates({
        displayNameInput: 'Workspace',
        currentDisplayName: 'Workspace',
        issueInput: 'https://github.com/stablyai/orca/pull/6934',
        prInput: '',
        commentInput: ''
      })
    ).toEqual({
      comment: '',
      linkedPR: null
    })
  })
})
