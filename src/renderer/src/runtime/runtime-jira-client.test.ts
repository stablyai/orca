// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  jiraGetIssue,
  jiraIssueComments,
  jiraListAssignableUsers,
  jiraSearchIssues
} from './runtime-jira-client'

type RuntimeSubscribeArgs = Parameters<typeof window.api.runtimeEnvironments.subscribe>[0]
type RuntimeSubscribeCallbacks = Parameters<typeof window.api.runtimeEnvironments.subscribe>[1]

const jiraSearchIssuesLocal = vi.fn()
const jiraListAssignableUsersLocal = vi.fn()
const runtimeCall = vi.fn()
const runtimeSubscribe = vi.fn()

beforeEach(() => {
  jiraSearchIssuesLocal.mockReset()
  jiraListAssignableUsersLocal.mockReset()
  runtimeCall.mockReset()
  runtimeSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: {
        searchIssues: jiraSearchIssuesLocal,
        listAssignableUsers: jiraListAssignableUsersLocal
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
