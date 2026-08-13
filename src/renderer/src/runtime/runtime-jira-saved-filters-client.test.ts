// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraListSavedFilters } from './runtime-jira-saved-filters-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

const listSavedFiltersLocal = vi.fn()
const runtimeCall = vi.fn()
const runtimeSubscribe = vi.fn()

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

const savedFilter = {
  id: '10001',
  name: 'Team backlog',
  jql: 'project = ALP',
  siteId: 'site-1'
}

function mockRuntimeCall(listResponse: { ok: boolean; result?: unknown; error?: unknown }): void {
  runtimeCall.mockImplementation(async (args: { method: string }) => {
    if (args.method === 'status.get') {
      return createCompatibleRuntimeStatusResponse()
    }
    return { id: 'rpc-1', ...listResponse, _meta: { runtimeId: 'remote-runtime' } }
  })
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  listSavedFiltersLocal.mockReset()
  runtimeCall.mockReset()
  runtimeSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: {
        listSavedFilters: listSavedFiltersLocal
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

describe('runtime Jira saved-filters client', () => {
  it('reads local saved filters through the preload bridge', async () => {
    listSavedFiltersLocal.mockResolvedValue([savedFilter])

    await expect(jiraListSavedFilters(localContext, 'site-1')).resolves.toEqual([savedFilter])

    expect(listSavedFiltersLocal).toHaveBeenCalledWith({ siteId: 'site-1' })
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('routes paired-runtime reads through jira.listSavedFilters RPC', async () => {
    mockRuntimeCall({ ok: true, result: [savedFilter] })

    await expect(jiraListSavedFilters(runtimeContext, 'site-1')).resolves.toEqual([savedFilter])

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'jira.listSavedFilters',
        params: { siteId: 'site-1' },
        selector: 'env-1'
      })
    )
    expect(listSavedFiltersLocal).not.toHaveBeenCalled()
  })

  it('degrades to an empty list when the remote host predates saved filters', async () => {
    mockRuntimeCall({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: jira.listSavedFilters' }
    })

    await expect(jiraListSavedFilters(runtimeContext)).resolves.toEqual([])
  })

  it('propagates other remote failures so the caller can report them', async () => {
    mockRuntimeCall({
      ok: false,
      error: { code: 'internal_error', message: 'boom' }
    })

    await expect(jiraListSavedFilters(runtimeContext)).rejects.toThrow('boom')
  })
})
