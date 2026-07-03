// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraListAssignableUsers, jiraSearchIssues } from './runtime-jira-client'

const jiraSearchIssuesLocal = vi.fn()
const jiraListAssignableUsersLocal = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  jiraSearchIssuesLocal.mockReset()
  jiraListAssignableUsersLocal.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: {
        searchIssues: jiraSearchIssuesLocal,
        listAssignableUsers: jiraListAssignableUsersLocal
      },
      runtimeEnvironments: {
        call: runtimeCall
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runtime Jira client search bounds', () => {
  it('rejects oversized local Jira search before IPC', async () => {
    await expect(jiraSearchIssues(null, 'secret-token-value'.repeat(1024), 30)).resolves.toEqual([])

    expect(jiraSearchIssuesLocal).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('rejects oversized runtime Jira assignee search before RPC', async () => {
    await expect(
      jiraListAssignableUsers(
        { activeRuntimeEnvironmentId: 'env-1' },
        'ORCA-1',
        'x'.repeat(9 * 1024),
        'site-1'
      )
    ).resolves.toEqual([])

    expect(jiraListAssignableUsersLocal).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
