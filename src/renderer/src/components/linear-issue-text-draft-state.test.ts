import { describe, expect, it } from 'vitest'
import {
  createLinearIssueTextDraftState,
  resolveLinearIssueTextDraftState
} from './linear-issue-text-draft-state'

describe('linear issue text draft state', () => {
  it('creates drafts from the issue source values', () => {
    expect(
      createLinearIssueTextDraftState({
        description: undefined,
        id: 'issue-1',
        title: 'Initial title'
      })
    ).toEqual({
      description: '',
      issueId: 'issue-1',
      sourceDescription: '',
      sourceTitle: 'Initial title',
      title: 'Initial title'
    })
  })

  it('resets both drafts when the issue changes', () => {
    const state = createLinearIssueTextDraftState({
      description: 'Old body',
      id: 'issue-1',
      title: 'Old title'
    })

    expect(
      resolveLinearIssueTextDraftState(
        { ...state, description: 'Unsaved body', title: 'Unsaved title' },
        {
          description: 'New body',
          id: 'issue-2',
          title: 'New title'
        }
      )
    ).toEqual({
      description: 'New body',
      issueId: 'issue-2',
      sourceDescription: 'New body',
      sourceTitle: 'New title',
      title: 'New title'
    })
  })

  it('reconciles untouched fields while preserving unsaved edits', () => {
    const state = createLinearIssueTextDraftState({
      description: 'Old body',
      id: 'issue-1',
      title: 'Old title'
    })

    expect(
      resolveLinearIssueTextDraftState(
        { ...state, title: 'Unsaved title' },
        {
          description: 'Remote body',
          id: 'issue-1',
          title: 'Remote title'
        }
      )
    ).toEqual({
      description: 'Remote body',
      issueId: 'issue-1',
      sourceDescription: 'Remote body',
      sourceTitle: 'Remote title',
      title: 'Unsaved title'
    })
  })
})
