// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from './runtime-rpc-client'
import { jiraConnect, jiraListAssignableUsers, jiraSearchIssues } from './runtime-jira-client'

const jiraConnectLocal = vi.fn()
const jiraSearchIssuesLocal = vi.fn()
const jiraListAssignableUsersLocal = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  jiraConnectLocal.mockReset()
  jiraSearchIssuesLocal.mockReset()
  jiraListAssignableUsersLocal.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: {
        connect: jiraConnectLocal,
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
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
})

describe('runtime Jira client search bounds', () => {
  it('forwards Jira Server connect payloads to local IPC', async () => {
    jiraConnectLocal.mockResolvedValueOnce({ ok: true, viewer: { displayName: 'Ada' } })

    const payload = {
      deploymentType: 'server' as const,
      authMode: 'basic' as const,
      siteUrl: 'https://jira.example.internal',
      username: 'ada',
      passwordOrToken: 'secret'
    }

    await expect(jiraConnect(null, payload)).resolves.toEqual({
      ok: true,
      viewer: { displayName: 'Ada' }
    })
    expect(jiraConnectLocal).toHaveBeenCalledWith(payload)
  })

  it('forwards Jira Server connect payloads to remote runtime RPC', async () => {
    markRuntimeEnvironmentCompatible('env-1')
    runtimeCall.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, viewer: { displayName: 'Ada' } }
    })

    const payload = {
      deploymentType: 'server' as const,
      authMode: 'bearer' as const,
      siteUrl: 'https://jira.example.internal',
      bearerToken: 'pat-secret'
    }

    await expect(jiraConnect({ activeRuntimeEnvironmentId: 'env-1' }, payload)).resolves.toEqual({
      ok: true,
      viewer: { displayName: 'Ada' }
    })
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'jira.connect',
      params: payload,
      timeoutMs: 30_000
    })
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
})
