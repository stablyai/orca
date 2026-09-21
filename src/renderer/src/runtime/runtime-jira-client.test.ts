// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  jiraCreateIssue,
  jiraGetIssue,
  jiraIssueComments,
  jiraListAssignableUsers,
  jiraLookupIssueSummary,
  jiraReadStatus,
  jiraSearchIssues,
  jiraSearchUsers
} from './runtime-jira-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import {
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/protocol-version'

type RuntimeSubscribeArgs = Parameters<typeof window.api.runtimeEnvironments.subscribe>[0]
type RuntimeSubscribeCallbacks = Parameters<typeof window.api.runtimeEnvironments.subscribe>[1]

const jiraSearchIssuesLocal = vi.fn()
const jiraListAssignableUsersLocal = vi.fn()
const jiraSearchUsersLocal = vi.fn()
const jiraCreateIssueLocal = vi.fn()
const jiraReadStatusLocal = vi.fn()
const jiraLookupIssueSummaryLocal = vi.fn()
const jiraCancelIssueSummaryLocal = vi.fn()
const runtimeCall = vi.fn()
const runtimeSubscribe = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  jiraSearchIssuesLocal.mockReset()
  jiraListAssignableUsersLocal.mockReset()
  jiraSearchUsersLocal.mockReset()
  jiraCreateIssueLocal.mockReset()
  jiraReadStatusLocal.mockReset()
  jiraLookupIssueSummaryLocal.mockReset()
  jiraCancelIssueSummaryLocal.mockReset()
  runtimeCall.mockReset()
  runtimeSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: {
        readStatus: jiraReadStatusLocal,
        lookupIssueSummary: jiraLookupIssueSummaryLocal,
        cancelIssueSummary: jiraCancelIssueSummaryLocal,
        searchIssues: jiraSearchIssuesLocal,
        listAssignableUsers: jiraListAssignableUsersLocal,
        searchUsers: jiraSearchUsersLocal,
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
  vi.unstubAllGlobals()
})

describe('runtime Jira client search bounds', () => {
  function createRuntimeStatusWithoutJiraUserFieldsCapability() {
    const status = createCompatibleRuntimeStatusResponse()
    if (!status.ok) {
      throw new Error('Expected a successful compatibility fixture.')
    }
    status.result.capabilities = status.result.capabilities?.filter(
      (capability) => capability !== JIRA_USER_FIELDS_RUNTIME_CAPABILITY
    )
    return status
  }

  it('routes isolated status and summary reads through local and paired-runtime owners', async () => {
    const localContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'project-1',
      hostId: 'local' as const
    }
    const runtimeContext = {
      ...localContext,
      hostId: 'runtime:env-1' as const
    }
    jiraReadStatusLocal.mockResolvedValue({ connected: true, viewer: null })
    jiraLookupIssueSummaryLocal.mockResolvedValue({ key: 'ORCA-1' })
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return createCompatibleRuntimeStatusResponse()
      }
      return {
        id: 'rpc-1',
        ok: true,
        result:
          args.method === 'jira.readStatus' ? { connected: true, viewer: null } : { key: 'ORCA-1' },
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(jiraReadStatus(localContext)).resolves.toMatchObject({ connected: true })
    await expect(jiraLookupIssueSummary(localContext, 'ORCA-1', 'site-1')).resolves.toMatchObject({
      key: 'ORCA-1'
    })
    await expect(jiraReadStatus(runtimeContext)).resolves.toMatchObject({ connected: true })
    await expect(jiraLookupIssueSummary(runtimeContext, 'ORCA-1', 'site-1')).resolves.toMatchObject(
      { key: 'ORCA-1' }
    )

    expect(jiraReadStatusLocal).toHaveBeenCalledTimes(1)
    expect(jiraLookupIssueSummaryLocal).toHaveBeenCalledWith({
      key: 'ORCA-1',
      siteId: 'site-1',
      requestId: expect.any(String)
    })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'jira.readStatus', selector: 'env-1' })
    )
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'jira.lookupIssueSummary',
        params: { key: 'ORCA-1', siteId: 'site-1' },
        selector: 'env-1'
      })
    )
  })

  it('cancels a superseded local Jira summary read', async () => {
    const context = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'project-1',
      hostId: 'local' as const
    }
    let rejectLookup: ((error: Error) => void) | undefined
    jiraLookupIssueSummaryLocal.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectLookup = reject
      })
    )
    jiraCancelIssueSummaryLocal.mockImplementation(async () => {
      rejectLookup?.(new Error('Jira request aborted'))
    })
    const controller = new AbortController()

    const lookup = jiraLookupIssueSummary(context, 'ORCA-1', 'site-1', controller.signal)
    controller.abort()

    await expect(lookup).rejects.toThrow('aborted')
    expect(jiraCancelIssueSummaryLocal).toHaveBeenCalledWith({
      requestId: expect.any(String)
    })
  })

  it('keeps direct SSH Jira reads local', async () => {
    const sshContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'project-1',
      hostId: 'ssh:server-1' as const
    }
    jiraReadStatusLocal.mockResolvedValue({ connected: false, viewer: null })

    await expect(jiraReadStatus(sshContext)).resolves.toMatchObject({ connected: false })

    expect(jiraReadStatusLocal).toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

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

  it('routes local Jira user search through IPC', async () => {
    jiraSearchUsersLocal.mockResolvedValue([{ accountId: 'account-1', displayName: 'Ada' }])

    await expect(jiraSearchUsers(null, 'Ada', 'site-1')).resolves.toEqual([
      { accountId: 'account-1', displayName: 'Ada' }
    ])

    expect(jiraSearchUsersLocal).toHaveBeenCalledWith({ query: 'Ada', siteId: 'site-1' })
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('routes remote Jira user search only when the host advertises the capability', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return createCompatibleRuntimeStatusResponse()
      }
      return {
        id: 'rpc-1',
        ok: true,
        result: [{ accountId: 'account-1', displayName: 'Ada' }],
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(
      jiraSearchUsers({ activeRuntimeEnvironmentId: 'env-1' }, 'Ada', 'site-1')
    ).resolves.toEqual([{ accountId: 'account-1', displayName: 'Ada' }])
    expect(runtimeCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'status.get', selector: 'env-1' })
    )
    expect(runtimeCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'jira.searchUsers',
        params: { query: 'Ada', siteId: 'site-1' },
        selector: 'env-1'
      })
    )
  })

  it('degrades remote Jira user search when the host lacks the capability', async () => {
    runtimeCall.mockResolvedValue(createRuntimeStatusWithoutJiraUserFieldsCapability())

    await expect(jiraSearchUsers({ activeRuntimeEnvironmentId: 'env-1' }, 'Ada')).resolves.toEqual(
      []
    )
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'jira.searchUsers' })
    )
  })

  it('blocks remote Jira user-field creation when the host lacks the capability', async () => {
    runtimeCall.mockResolvedValue(createRuntimeStatusWithoutJiraUserFieldsCapability())

    await expect(
      jiraCreateIssue(
        { activeRuntimeEnvironmentId: 'env-1' },
        {
          projectId: 'project-1',
          issueTypeId: 'type-1',
          title: 'Issue',
          userFieldKeys: ['reporter']
        }
      )
    ).rejects.toThrow(JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE)
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'jira.createIssue' })
    )
  })

  it('keeps ordinary remote Jira creation compatible with hosts without the user-field capability', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return createRuntimeStatusWithoutJiraUserFieldsCapability()
      }
      return {
        id: 'rpc-1',
        ok: true,
        result: { ok: true, id: 'issue-1', key: 'ORCA-1', url: 'https://jira.example/ORCA-1' },
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(
      jiraCreateIssue(
        { activeRuntimeEnvironmentId: 'env-1' },
        { projectId: 'project-1', issueTypeId: 'type-1', title: 'Issue' }
      )
    ).resolves.toMatchObject({ ok: true, key: 'ORCA-1' })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'jira.createIssue', selector: 'env-1' })
    )
  })

  it('routes remote Jira user-field creation after capability validation', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return createCompatibleRuntimeStatusResponse()
      }
      return {
        id: 'rpc-1',
        ok: true,
        result: { ok: true, id: 'issue-1', key: 'ORCA-1', url: 'https://jira.example/ORCA-1' },
        _meta: { runtimeId: 'remote-runtime' }
      }
    })

    await expect(
      jiraCreateIssue(
        { activeRuntimeEnvironmentId: 'env-1' },
        {
          projectId: 'project-1',
          issueTypeId: 'type-1',
          title: 'Issue',
          customFields: { reporter: 'account-1' },
          userFieldKeys: ['reporter']
        }
      )
    ).resolves.toMatchObject({ ok: true, key: 'ORCA-1' })

    expect(runtimeCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'jira.createIssue',
        params: {
          projectId: 'project-1',
          issueTypeId: 'type-1',
          title: 'Issue',
          customFields: { reporter: 'account-1' },
          userFieldKeys: ['reporter']
        },
        selector: 'env-1'
      })
    )
  })

  it('streams image-bearing issue and comment payloads from remote runtimes', async () => {
    runtimeSubscribe.mockImplementation(
      async (args: RuntimeSubscribeArgs, callbacks: RuntimeSubscribeCallbacks) => {
        const payload =
          args.method === 'jira.getIssueStream'
            ? { key: 'ORCA-1', description: '![shot](data:image/png;base64,abc)' }
            : [{ id: 'comment-1', body: '![shot](data:image/png;base64,abc)' }]
        callbacks.onResponse({
          id: 'rpc-1',
          ok: true,
          result: { type: 'chunk', content: JSON.stringify(payload) },
          _meta: { runtimeId: 'runtime-1' }
        })
        callbacks.onResponse({
          id: 'rpc-1',
          ok: true,
          result: { type: 'end' },
          _meta: { runtimeId: 'runtime-1' }
        })
        return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
      }
    )

    await expect(
      jiraGetIssue({ activeRuntimeEnvironmentId: 'env-1' }, 'ORCA-1', 'site-1')
    ).resolves.toMatchObject({ key: 'ORCA-1' })
    await expect(
      jiraIssueComments({ activeRuntimeEnvironmentId: 'env-1' }, 'ORCA-1', 'site-1')
    ).resolves.toMatchObject([{ id: 'comment-1' }])

    expect(runtimeSubscribe).toHaveBeenNthCalledWith(
      1,
      {
        selector: 'env-1',
        method: 'jira.getIssueStream',
        params: { key: 'ORCA-1', siteId: 'site-1' },
        timeoutMs: 60_000
      },
      expect.anything()
    )
    expect(runtimeSubscribe).toHaveBeenNthCalledWith(
      2,
      {
        selector: 'env-1',
        method: 'jira.issueCommentsStream',
        params: { key: 'ORCA-1', siteId: 'site-1' },
        timeoutMs: 60_000
      },
      expect.anything()
    )
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
