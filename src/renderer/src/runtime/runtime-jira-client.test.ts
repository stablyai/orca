// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  jiraSearchIssuesForTarget,
  jiraStatusForTarget,
  jiraListAssignableUsersForProject,
  jiraGetIssueEditFieldsForTarget,
  jiraUpdateIssueForTarget
} from './runtime-jira-client'
import { clearJiraImageCache } from './runtime-jira-image-cache'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import { JIRA_ISSUE_EDIT_FIELDS_RUNTIME_CAPABILITY } from '../../../shared/jira/jira-detail-capabilities'
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

describe('edit-screen fields on mixed remote versions', () => {
  const target = { kind: 'environment' as const, environmentId: 'env-1' }

  function mockHost(withEditFields: boolean): void {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        const response = createCompatibleRuntimeStatusResponse()
        if (!response.ok) {
          throw new Error('Expected status fixture')
        }
        response.result.capabilities = response.result.capabilities?.filter(
          (capability) => withEditFields || capability !== JIRA_ISSUE_EDIT_FIELDS_RUNTIME_CAPABILITY
        )
        return response
      }
      if (args.method === 'jira.getIssueEditFields') {
        return { id: 'rpc-1', ok: true, result: [] }
      }
      return { id: 'rpc-1', ok: true, result: { ok: true } }
    })
  }

  it('hides edit fields and refuses field writes on hosts that would strip them', async () => {
    mockHost(false)
    await expect(jiraGetIssueEditFieldsForTarget(target, 'APP-1', 'site-1')).resolves.toBeNull()
    await expect(
      jiraUpdateIssueForTarget(target, 'APP-1', { fields: { duedate: '2026-10-20' } }, 'site-1')
    ).rejects.toThrow('Update the remote Orca server')
    const methods = runtimeCall.mock.calls.map(([args]) => args.method)
    expect(methods).not.toContain('jira.getIssueEditFields')
    expect(methods).not.toContain('jira.updateIssue')
  })

  it('reads edit fields strictly from hosts that advertise them', async () => {
    mockHost(true)
    await expect(jiraGetIssueEditFieldsForTarget(target, 'APP-1', 'site-1')).resolves.toEqual([])
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'jira.getIssueEditFields',
        params: { key: 'APP-1', siteId: 'site-1', strict: true },
        selector: 'env-1'
      })
    )
  })
})
