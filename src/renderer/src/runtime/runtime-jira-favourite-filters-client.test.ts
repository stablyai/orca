// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraListFavouriteFiltersForTarget } from './runtime-jira-favourite-filters-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'

const transport = vi.hoisted(() => ({ rpc: vi.fn(), local: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: transport.rpc }))

const remote = { kind: 'environment', environmentId: 'account-owner' } as const
const local = { kind: 'local' } as const
const filter = { id: '10001', name: 'My work', jql: 'project = 10002', siteId: 'site-a' }
const envelope = { filters: [filter], truncated: false }

function rpcError(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'favourites',
    ok: false,
    error: { code, message: 'Favourite read failed' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { jira: { listFavouriteFilters: transport.local } }
  })
  transport.local.mockResolvedValue(envelope)
  transport.rpc.mockResolvedValue(envelope)
})

describe('Jira favourite catalogue transport', () => {
  it('reads only from the captured remote owner with an explicit site', async () => {
    await expect(jiraListFavouriteFiltersForTarget(remote, 'site-a')).resolves.toEqual({
      supported: true,
      ...envelope
    })
    expect(transport.rpc).toHaveBeenCalledExactlyOnceWith(
      remote,
      'jira.listFavouriteFilters',
      { siteId: 'site-a' },
      { timeoutMs: 30_000 }
    )
    expect(transport.local).not.toHaveBeenCalled()
  })

  it('uses the local bridge with the same site contract', async () => {
    await expect(jiraListFavouriteFiltersForTarget(local, 'site-a')).resolves.toEqual({
      supported: true,
      ...envelope
    })
    expect(transport.local).toHaveBeenCalledExactlyOnceWith({ siteId: 'site-a' })
    expect(transport.rpc).not.toHaveBeenCalled()
  })

  it.each(['', ' ', 'all', 'a'.repeat(129)])(
    'refuses invalid site %j before transport',
    async (site) => {
      await expect(jiraListFavouriteFiltersForTarget(remote, site)).rejects.toThrow()
      await expect(jiraListFavouriteFiltersForTarget(local, site)).rejects.toThrow()
      expect(transport.rpc).not.toHaveBeenCalled()
      expect(transport.local).not.toHaveBeenCalled()
    }
  )

  it('reports older paired hosts as unsupported without falling back to local credentials', async () => {
    transport.rpc.mockRejectedValue(rpcError('method_not_found'))
    await expect(jiraListFavouriteFiltersForTarget(remote, 'site-a')).resolves.toEqual({
      supported: false
    })
    expect(transport.rpc).toHaveBeenCalledTimes(1)
    expect(transport.local).not.toHaveBeenCalled()
  })

  it('recognizes missing-method codes from the web bridge without a class dependency', async () => {
    transport.local.mockRejectedValue(
      Object.assign(new Error('Unknown Jira method'), { code: 'method_not_found' })
    )
    await expect(jiraListFavouriteFiltersForTarget(local, 'site-a')).resolves.toEqual({
      supported: false
    })
    expect(transport.local).toHaveBeenCalledTimes(1)
    expect(transport.rpc).not.toHaveBeenCalled()
  })

  it.each(['forbidden', 'timeout'])('preserves web bridge %s errors', async (code) => {
    const error = Object.assign(new Error('Jira read failed'), { code })
    transport.local.mockRejectedValue(error)
    await expect(jiraListFavouriteFiltersForTarget(local, 'site-a')).rejects.toBe(error)
    expect(transport.local).toHaveBeenCalledTimes(1)
    expect(transport.rpc).not.toHaveBeenCalled()
  })

  it('reports a missing local bridge as unsupported without making a request', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { jira: {} } })
    await expect(jiraListFavouriteFiltersForTarget(local, 'site-a')).resolves.toEqual({
      supported: false
    })
    expect(transport.rpc).not.toHaveBeenCalled()
  })

  it.each(['forbidden', 'remote_runtime_unavailable', 'timeout', 'internal_error'])(
    'surfaces %s without retrying or switching credential owners',
    async (code) => {
      const error = rpcError(code)
      transport.rpc.mockRejectedValue(error)
      await expect(jiraListFavouriteFiltersForTarget(remote, 'site-a')).rejects.toBe(error)
      expect(transport.rpc).toHaveBeenCalledTimes(1)
      expect(transport.local).not.toHaveBeenCalled()
    }
  )

  it('does not mistake a text error for a missing RPC method', async () => {
    const error = new Error('method_not_found')
    transport.rpc.mockRejectedValue(error)
    await expect(jiraListFavouriteFiltersForTarget(remote, 'site-a')).rejects.toBe(error)
  })

  it.each([local, remote])('refuses cross-site data from %j', async (target) => {
    const wrongSite = { filters: [{ ...filter, siteId: 'site-b' }], truncated: false }
    transport.rpc.mockResolvedValue(wrongSite)
    transport.local.mockResolvedValue(wrongSite)
    await expect(jiraListFavouriteFiltersForTarget(target, 'site-a')).rejects.toThrow()
  })

  it.each([undefined, [], { filters: [] }, { filters: 'invalid', truncated: false }])(
    'does not silently treat a malformed supported response as an empty catalogue: %j',
    async (value) => {
      transport.rpc.mockResolvedValue(value)
      await expect(jiraListFavouriteFiltersForTarget(remote, 'site-a')).rejects.toThrow()
    }
  )

  it('preserves empty and truncated catalogues distinctly', async () => {
    transport.rpc.mockResolvedValue({ filters: [], truncated: true })
    await expect(jiraListFavouriteFiltersForTarget(remote, 'site-a')).resolves.toEqual({
      supported: true,
      filters: [],
      truncated: true
    })
  })

  it('accepts a newer host adding fields without losing the originating site', async () => {
    transport.rpc.mockResolvedValue({
      ...envelope,
      nextPage: null,
      filters: [{ ...filter, displayOwner: { name: 'New field' } }]
    })
    await expect(jiraListFavouriteFiltersForTarget(remote, 'site-a')).resolves.toEqual({
      supported: true,
      ...envelope
    })
  })

  it('keeps failures from the local owner visible', async () => {
    const error = new Error('Credentials unavailable')
    transport.local.mockRejectedValue(error)
    await expect(jiraListFavouriteFiltersForTarget(local, 'site-a')).rejects.toBe(error)
    expect(transport.rpc).not.toHaveBeenCalled()
  })
})
