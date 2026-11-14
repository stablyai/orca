// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadLinearIssueView } from './linear-issue-view-storage'

const STORAGE_KEY = 'orca.linear.issue-view.v1'

describe('Linear issue view local storage', () => {
  beforeEach(() => {
    localStorage.clear()
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
})
