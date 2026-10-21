// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraListProjectsForTarget, jiraStatusForTarget } from './runtime-jira-project-client'

const { callRuntimeRpc, rowLessSourceTarget } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  rowLessSourceTarget: vi.fn(() => {
    throw new Error('Project inventory must not resolve the default host')
  })
}))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc }))
vi.mock('@/lib/default-creation-host', () => ({ rowLessSourceTarget }))

const status = vi.fn()
const listProjects = vi.fn()
const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site' }

beforeEach(() => {
  vi.clearAllMocks()
  status.mockResolvedValue({ connected: true, viewer: null })
  listProjects.mockResolvedValue([project])
  vi.stubGlobal('window', { api: { jira: { status, listProjects } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('Jira project inventory target transport', () => {
  it('reads local status and every site through IPC without a default-host lookup', async () => {
    await expect(jiraStatusForTarget({ kind: 'local' })).resolves.toMatchObject({ connected: true })
    await expect(jiraListProjectsForTarget({ kind: 'local' }, 'all')).resolves.toEqual([project])
    expect(status).toHaveBeenCalledExactlyOnceWith()
    expect(listProjects).toHaveBeenCalledExactlyOnceWith({ siteId: 'all' })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(rowLessSourceTarget).not.toHaveBeenCalled()
  })

  it('sends status and project reads to the explicit paired owner', async () => {
    const target = { kind: 'environment', environmentId: 'owner' } as const
    callRuntimeRpc.mockImplementation(async (_target, method) =>
      method === 'jira.status' ? { connected: true, viewer: null } : [project]
    )
    await expect(jiraStatusForTarget(target)).resolves.toMatchObject({ connected: true })
    await expect(jiraListProjectsForTarget(target, 'all')).resolves.toEqual([project])
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(1, target, 'jira.status', undefined, {
      timeoutMs: 15_000
    })
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      target,
      'jira.listProjects',
      { siteId: 'all' },
      { timeoutMs: 30_000 }
    )
    expect(status).not.toHaveBeenCalled()
    expect(listProjects).not.toHaveBeenCalled()
    expect(rowLessSourceTarget).not.toHaveBeenCalled()
  })

  it('keeps the optional project selector absent and normalizes a malformed status', async () => {
    status.mockResolvedValue(undefined)
    await expect(jiraStatusForTarget({ kind: 'local' })).resolves.toEqual({
      connected: false,
      viewer: null
    })
    await jiraListProjectsForTarget({ kind: 'local' })
    expect(listProjects).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})
