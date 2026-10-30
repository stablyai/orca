// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  jiraSearchIssuesForTarget,
  jiraStatusForTarget,
  jiraListAssignableUsersForProject
} from './runtime-jira-client'
import { clearJiraImageCache } from './runtime-jira-image-cache'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
const jiraSearchIssuesLocal = vi.fn()
const jiraStatusLocal = vi.fn()
const jiraListAssignableUsersLocal = vi.fn()
const jiraSearchUsersLocal = vi.fn()
const jiraProjectUsersLocal = vi.fn()
const jiraCreateIssueLocal = vi.fn()
const jiraReadStatusLocal = vi.fn()
const jiraLookupIssueSummaryLocal = vi.fn()
const jiraCancelIssueSummaryLocal = vi.fn()
const runtimeCall = vi.fn()
const runtimeSubscribe = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  jiraSearchIssuesLocal.mockReset()
  jiraStatusLocal.mockReset()
  jiraListAssignableUsersLocal.mockReset()
  jiraSearchUsersLocal.mockReset()
  jiraProjectUsersLocal.mockReset()
  jiraCreateIssueLocal.mockReset()
  jiraReadStatusLocal.mockReset()
  jiraLookupIssueSummaryLocal.mockReset()
  jiraCancelIssueSummaryLocal.mockReset()
  runtimeCall.mockReset()
  runtimeSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: {
        status: jiraStatusLocal,
        readStatus: jiraReadStatusLocal,
        lookupIssueSummary: jiraLookupIssueSummaryLocal,
        cancelIssueSummary: jiraCancelIssueSummaryLocal,
        searchIssues: jiraSearchIssuesLocal,
        listAssignableUsers: jiraListAssignableUsersLocal,
        searchUsers: jiraSearchUsersLocal,
        listAssignableUsersForProject: jiraProjectUsersLocal,
        createIssue: jiraCreateIssueLocal
      },
      runtimeEnvironments: {
        call: runtimeCall,
        subscribe: runtimeSubscribe
      }
    }
  })
})

afterEach(() => {
  clearJiraImageCache()
  vi.unstubAllGlobals()
})
describe('runtime Jira client search bounds', () => {
  it('keeps explicit Jira status and search on their owner with the selected site and query bounds', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return createCompatibleRuntimeStatusResponse()
      }
      return {
        id: 'rpc-result',
        ok: true,
        result:
          args.method === 'jira.status'
            ? { connected: true, viewer: null, selectedSiteId: 'all' }
            : [],
        _meta: { runtimeId: 'source-owner-runtime' }
      }
    })
    const target = { kind: 'environment', environmentId: 'source-owner' } as const
    await expect(jiraStatusForTarget(target)).resolves.toMatchObject({
      connected: true,
      selectedSiteId: 'all'
    })
    await jiraSearchIssuesForTarget(target, 'text ~ "login*"', 12, 'all')
    await jiraSearchIssuesForTarget(target, 'secret-token-value'.repeat(1024), 12)
    expect(runtimeCall).toHaveBeenCalledTimes(3)
    expect(runtimeCall).toHaveBeenLastCalledWith({
      selector: 'source-owner',
      method: 'jira.searchIssues',
      params: { jql: 'text ~ "login*"', limit: 12, siteId: 'all' },
      timeoutMs: 30_000
    })
    expect(jiraStatusLocal).not.toHaveBeenCalled()
    expect(jiraSearchIssuesLocal).not.toHaveBeenCalled()
  })

  it('uses project-scoped search locally and rejects oversized queries before IPC', async () => {
    jiraProjectUsersLocal.mockResolvedValue([])
    await jiraListAssignableUsersForProject({ kind: 'local' }, '100', 'Ada', 'site-1')
    expect(jiraProjectUsersLocal).toHaveBeenCalledWith({
      projectIdOrKey: '100',
      query: 'Ada',
      siteId: 'site-1'
    })
    await jiraListAssignableUsersForProject({ kind: 'local' }, '100', 'x'.repeat(20_000), 'site-1')
    expect(jiraProjectUsersLocal).toHaveBeenCalledTimes(1)
  })
})
