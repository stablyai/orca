// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { jiraSearchIssuesForTarget } from './runtime-jira-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

const searchLocal = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  searchLocal.mockReset()
  runtimeCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: { searchIssues: searchLocal },
      runtimeEnvironments: { call: runtimeCall, subscribe: vi.fn() }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('carries numeric suggestions to both local IPC and the selected remote owner', async () => {
  const suggestions = { query: '400', currentJql: 'sprint in openSprints()' }
  searchLocal.mockResolvedValue([{ key: 'LOCAL-400' }])
  runtimeCall.mockImplementation(async (args: { method: string }) =>
    args.method === 'status.get'
      ? createCompatibleRuntimeStatusResponse()
      : {
          id: 'search',
          ok: true,
          result: [{ key: 'REMOTE-400' }],
          _meta: { runtimeId: 'owner' }
        }
  )

  await expect(
    jiraSearchIssuesForTarget({ kind: 'local' }, 'text ~ "400*"', 12, 'site-a', undefined, suggestions)
  ).resolves.toEqual([{ key: 'LOCAL-400' }])
  expect(searchLocal).toHaveBeenCalledExactlyOnceWith({
    jql: 'text ~ "400*"',
    limit: 12,
    siteId: 'site-a',
    suggestions
  })

  await expect(
    jiraSearchIssuesForTarget(
      { kind: 'environment', environmentId: 'owner' },
      'text ~ "400*"',
      12,
      'site-b',
      undefined,
      suggestions
    )
  ).resolves.toEqual([{ key: 'REMOTE-400' }])
  expect(runtimeCall).toHaveBeenLastCalledWith({
    selector: 'owner',
    method: 'jira.searchIssues',
    params: { jql: 'text ~ "400*"', limit: 12, siteId: 'site-b', suggestions },
    timeoutMs: 30_000
  })
})
