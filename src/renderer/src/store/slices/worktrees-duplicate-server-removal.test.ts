import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { runtimeTargetForWorktreeOwner } from './worktrees/listing/worktree-owner-target'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(resetWorktreeSliceModuleMemory)

const WORKTREE_ID = 'repo-ssh::/srv/same-wt'

function storeWithTwoServersPublishing(hostKeys: [string, string]) {
  const store = createTestStore()
  const environment = (
    id: string,
    name: string,
    hostKeyFingerprint: string
  ): PublicKnownRuntimeEnvironment => ({
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `ws-${id}`, kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
    preferredEndpointId: `ws-${id}`,
    hostKeyFingerprint
  })
  store.setState({
    runtimeEnvironments: [
      environment('hub-a', 'Studio', hostKeys[0]),
      environment('hub-b', 'Studio relay', hostKeys[1])
    ],
    worktreesByRepo: {
      'repo-ssh': ['hub-a', 'hub-b'].map((runtimeOwnerEnvironmentId) =>
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo-ssh',
          hostId: 'ssh:same-private-target',
          runtimeOwnerEnvironmentId
        })
      )
    }
  })
  return store
}

describe('removing a workspace two saved servers publish', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('names both entries and the fix when they are one server paired twice', async () => {
    const store = storeWithTwoServersPublishing(['key-1', 'key-1'])
    const result = await store.getState().removeWorktree({ id: WORKTREE_ID, executionHostId: null })
    expect(result).toEqual({
      ok: false,
      error:
        'Studio and Studio relay are the same server paired twice. Remove one in Settings > Remote Orca Servers.'
    })
  })

  it('keeps the generic refusal for two different servers', async () => {
    const store = storeWithTwoServersPublishing(['key-1', 'key-2'])
    const result = await store.getState().removeWorktree({ id: WORKTREE_ID, executionHostId: null })
    expect(result).toEqual({
      ok: false,
      error: 'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
    })
  })
})

describe('resolving the owner of a workspace two twins publish', () => {
  it('keeps the generic refusal when the caller named the host', () => {
    const store = storeWithTwoServersPublishing(['key-1', 'key-1'])
    expect(() =>
      runtimeTargetForWorktreeOwner(store.getState(), WORKTREE_ID, 'ssh:same-private-target')
    ).toThrow('Workspace identity is ambiguous across hosts. Refresh projects and try again.')
    expect(() => runtimeTargetForWorktreeOwner(store.getState(), WORKTREE_ID)).toThrow(
      'Studio and Studio relay are the same server paired twice.'
    )
  })
})
