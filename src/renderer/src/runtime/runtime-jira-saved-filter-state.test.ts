// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readJiraSavedFilterState, mutateJiraSavedFilters } from './runtime-jira-saved-filter-state'
import { JIRA_SAVED_FILTER_RUNTIME_CAPABILITY } from '../../../shared/jira-saved-filter-capability'
const { assertCapability, rpc } = vi.hoisted(() => ({ assertCapability: vi.fn(), rpc: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: assertCapability,
  callRuntimeRpc: rpc
}))
const state = {
  filters: [{ id: 'mine', name: 'My work', jql: 'project = APP' }],
  activeFilterId: 'mine'
}
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})
it('uses local UI state for local execution', async () => {
  const read = vi.fn(async () => state)
  const mutate = vi.fn(async () => state)
  vi.stubGlobal('window', {
    api: { ui: { getJiraSavedFilters: read, mutateJiraSavedFilters: mutate } }
  })
  expect(await readJiraSavedFilterState({ kind: 'local' })).toEqual(state)
  await mutateJiraSavedFilters({ kind: 'local' }, { kind: 'select', id: 'mine' })
  expect(mutate).toHaveBeenCalledWith({ kind: 'select', id: 'mine' })
  expect(rpc).not.toHaveBeenCalled()
})
it('routes paired/SSH persistence to the selected Jira host rather than this device', async () => {
  rpc.mockResolvedValue(state)
  const target = { kind: 'environment', environmentId: 'ssh-host-b' } as const
  expect(await readJiraSavedFilterState(target)).toEqual(state)
  await mutateJiraSavedFilters(target, { kind: 'select', id: 'mine' })
  expect(assertCapability).toHaveBeenCalledWith(
    'ssh-host-b',
    JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
    expect.any(String),
    15_000
  )
  expect(rpc).toHaveBeenCalledWith(
    target,
    'ui.mutateJiraSavedFilters',
    { kind: 'select', id: 'mine' },
    { timeoutMs: 15_000 }
  )
  expect(rpc.mock.calls.some(([, method]) => method === 'ui.set')).toBe(false)
})
it('never sends new fields to an older host or falls back to local persistence', async () => {
  assertCapability.mockRejectedValue(new Error('Update the Jira host'))
  await expect(
    mutateJiraSavedFilters(
      { kind: 'environment', environmentId: 'old-host' },
      { kind: 'select', id: 'mine' }
    )
  ).rejects.toThrow('Update')
  expect(rpc).not.toHaveBeenCalled()
})
it('propagates loss of contact instead of pretending the write was saved', async () => {
  rpc.mockRejectedValue(new Error('Connection lost'))
  await expect(
    mutateJiraSavedFilters(
      { kind: 'environment', environmentId: 'host-a' },
      { kind: 'select', id: null }
    )
  ).rejects.toThrow('Connection lost')
})
