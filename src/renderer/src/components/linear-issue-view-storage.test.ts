// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultLinearIssueViewResumeState } from '../../../shared/linear-issue-view-resume-state'
import { loadLinearIssueView, saveLinearIssueView } from './linear-issue-view-storage'

const STORAGE_KEY = 'orca.linear.issue-view.v1'

describe('Linear issue view local storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('falls back to defaults when nothing is stored', () => {
    expect(loadLinearIssueView()).toEqual(defaultLinearIssueViewResumeState())
  })

  it('round-trips a non-default view', () => {
    const view = {
      ...defaultLinearIssueViewResumeState(),
      viewMode: 'board' as const,
      groupBy: 'assignee' as const,
      filtersByWorkspaceId: {
        'workspace-1': { stateIds: ['state-a'], priorities: [2], assignee: null, labelIds: [] }
      }
    }

    saveLinearIssueView(view)

    expect(loadLinearIssueView()).toEqual(view)
  })

  it('clears the key when the view returns to defaults', () => {
    saveLinearIssueView({ ...defaultLinearIssueViewResumeState(), viewMode: 'board' })

    saveLinearIssueView(defaultLinearIssueViewResumeState())

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(loadLinearIssueView()).toEqual(defaultLinearIssueViewResumeState())
  })

  it('falls back to defaults when the stored value is unparseable', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')

    expect(loadLinearIssueView()).toEqual(defaultLinearIssueViewResumeState())
  })

  it('drops a corrupt workspace filter without losing the other workspaces', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        viewMode: 'board',
        filtersByWorkspaceId: {
          'workspace-1': { stateIds: 'not-an-array' },
          'workspace-2': { stateIds: [], priorities: [1], assignee: null, labelIds: [] }
        }
      })
    )

    expect(loadLinearIssueView().filtersByWorkspaceId).toEqual({
      'workspace-2': { stateIds: [], priorities: [1], assignee: null, labelIds: [] }
    })
  })

  it('normalizes an out-of-catalog option instead of discarding the whole view', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ viewMode: 'board', groupBy: 'nonsense', orderBy: 'updated' })
    )

    const view = loadLinearIssueView()

    expect(view.viewMode).toBe('board')
    expect(view.groupBy).toBe('none')
    expect(view.orderBy).toBe('updated')
  })
})
