import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(async () => {
    throw new Error('Update Orca on the workspace host')
  }),
  call: vi.fn(async () => ({ repo: undefined }))
}))

vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertRuntimeEnvironmentCapability: mocks.assertCapability,
  callRuntimeRpc: mocks.call
}))

describe('required removal configuration on older hosts', () => {
  it('refuses to save a remove script when its execution host cannot enforce it', async () => {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo',
          path: '/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:old'
        }
      ]
    })
    const saved = await store.getState().updateRepo(
      'repo',
      {
        hookSettings: { mode: 'auto', scripts: { setup: '', archive: '', remove: 'dispose' } }
      },
      { hostId: 'runtime:old' }
    )
    expect(saved).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
    expect(store.getState().repos[0].hookSettings).toBeUndefined()
  })
})
