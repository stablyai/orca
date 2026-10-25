// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraListPriorities } from './runtime-jira-client'
import { jiraListPrioritiesForTarget } from './runtime-jira-detail-client'
import { defaultScopeSource } from '@/lib/default-creation-host'

const transport = vi.hoisted(() => ({ rpc: vi.fn(), local: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: transport.rpc }))

beforeEach(() => {
  vi.clearAllMocks()
  transport.rpc.mockResolvedValue([])
  transport.local.mockResolvedValue([])
  vi.stubGlobal('window', { api: { jira: { listPriorities: transport.local } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('Jira priority owner transport', () => {
  it('keeps local site selection and returned priorities intact', async () => {
    const priorities = [{ id: 'custom', name: 'Immediate' }]
    transport.local.mockResolvedValue(priorities)
    await expect(jiraListPrioritiesForTarget({ kind: 'local' }, 'site-1')).resolves.toBe(priorities)
    expect(transport.local).toHaveBeenCalledWith({ siteId: 'site-1' })
    expect(transport.rpc).not.toHaveBeenCalled()
  })

  it('keeps absent site selection absent', async () => {
    await jiraListPrioritiesForTarget({ kind: 'local' }, null)
    expect(transport.local).toHaveBeenCalledWith(undefined)
  })

  it('sends the captured remote owner, selected site, and existing deadline', async () => {
    const target = { kind: 'environment' as const, environmentId: 'owner' }
    await jiraListPrioritiesForTarget(target, 'site-1')
    expect(transport.rpc).toHaveBeenCalledWith(
      target,
      'jira.listPriorities',
      { siteId: 'site-1' },
      { timeoutMs: 30_000 }
    )
    expect(transport.local).not.toHaveBeenCalled()
  })

  it('preserves the settings compatibility entry point', async () => {
    await jiraListPriorities(defaultScopeSource({ activeRuntimeEnvironmentId: 'legacy' }), null)
    expect(transport.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'legacy' },
      'jira.listPriorities',
      undefined,
      { timeoutMs: 30_000 }
    )
  })

  it('preserves the explicit-source compatibility entry point', async () => {
    await jiraListPriorities(
      { kind: 'task-source', provider: 'jira', projectId: 'project', hostId: 'runtime:source' },
      'site-1'
    )
    expect(transport.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'source' },
      'jira.listPriorities',
      { siteId: 'site-1' },
      { timeoutMs: 30_000 }
    )
  })

  it('propagates remote failure without querying the local account', async () => {
    transport.rpc.mockRejectedValue(new Error('Owner unavailable'))
    await expect(
      jiraListPrioritiesForTarget({ kind: 'environment', environmentId: 'owner' }, 'site-1')
    ).rejects.toThrow('Owner unavailable')
    expect(transport.local).not.toHaveBeenCalled()
  })
})
