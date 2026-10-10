import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

type RuntimeCall = { method: string; params: unknown }

function mockRuntimeClient(resultFor: (method: string) => unknown): RuntimeCall[] {
  const runtimeCalls: RuntimeCall[] = []
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
        runtimeCalls.push({ method, params })
        return Promise.resolve({
          id: `call-${runtimeCalls.length}`,
          ok: true,
          result: resultFor(method),
          _meta: { runtimeId: 'runtime-1' }
        })
      }

      subscribe(
        method: string,
        params: unknown,
        callbacks: { onResponse: (response: RuntimeRpcResponse<unknown>) => void }
      ): Promise<{ unsubscribe: () => void }> {
        runtimeCalls.push({ method, params })
        const payload = JSON.stringify(resultFor(method))
        for (const result of [{ type: 'chunk', content: payload }, { type: 'end' }]) {
          callbacks.onResponse({ id: 'stream-1', ok: true, result, _meta: { runtimeId: 'r-1' } })
        }
        return Promise.resolve({ unsubscribe: () => {} })
      }

      close(): void {}
    }
  }))
  return runtimeCalls
}

async function installApi() {
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  // Why: return the globals, not the api proxy, which reads as a thenable.
  return globals
}

describe('web Jira preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('routes Jira connector calls through the paired runtime', async () => {
    const runtimeCalls = mockRuntimeClient((method) =>
      method === 'jira.connect'
        ? { ok: true, viewer: { accountId: 'viewer-1', displayName: 'Test User' } }
        : { connected: false, viewer: null }
    )
    const {
      window: { api }
    } = await installApi()
    const credentials = {
      siteUrl: 'https://jira.example.com',
      email: 'user@example.com',
      apiToken: 'token'
    }

    await expect(api.jira.connect(credentials)).resolves.toMatchObject({ ok: true })
    await expect(api.jira.status()).resolves.toEqual({ connected: false, viewer: null })

    expect(runtimeCalls).toEqual([
      { method: 'jira.connect', params: credentials },
      { method: 'jira.status', params: undefined }
    ])
  })

  it('maps desktop-only Jira methods onto the server methods that exist', async () => {
    const runtimeCalls = mockRuntimeClient(() => [])
    const {
      window: { api }
    } = await installApi()

    await api.jira.searchIssues({ jql: 'project = ORCA', siteId: 'site-1', requestId: 'r1' })
    await api.jira.lookupIssueSummary({ key: 'ORCA-1', siteId: 'site-1', requestId: 'r2' })
    await api.jira.listAssignableUsersForProject({
      projectIdOrKey: 'ORCA',
      query: 'ann',
      siteId: 'site-1'
    })
    await expect(api.jira.cancelSearchIssues({ requestId: 'r1' })).resolves.toBeUndefined()
    await expect(api.jira.cancelIssueSummary({ requestId: 'r2' })).resolves.toBeUndefined()

    expect(runtimeCalls).toEqual([
      { method: 'jira.searchIssues', params: { jql: 'project = ORCA', siteId: 'site-1' } },
      { method: 'jira.lookupIssueSummary', params: { key: 'ORCA-1', siteId: 'site-1' } },
      { method: 'jira.searchUsers', params: { query: 'ann', siteId: 'site-1' } }
    ])
  })

  it('streams issue details so inline images are not cut off by the socket frame cap', async () => {
    const issue = { key: 'ORCA-1', title: 'Large issue' }
    const runtimeCalls = mockRuntimeClient((method) =>
      method === 'jira.getIssueStream' ? issue : null
    )
    const {
      window: { api }
    } = await installApi()

    await expect(api.jira.getIssue({ key: 'ORCA-1', siteId: 'site-1' })).resolves.toEqual(issue)
    expect(runtimeCalls).toEqual([
      { method: 'jira.getIssueStream', params: { key: 'ORCA-1', siteId: 'site-1' } }
    ])
  })
})
