import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { resetDeferredPeerChecksForTests } from './runtime-environment-peer-replacement'

const WORKTREE_ID = 'repo-1::/root/repo'

/** The managed server as main lists it; an update rewrites its pairing and bumps the revision. */
function server(
  pairingRevision: number,
  hostKeyFingerprint?: string
): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Box server',
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws', kind: 'websocket', label: 'Box', endpoint: 'ws://127.0.0.1:46768/' }],
    preferredEndpointId: 'ws',
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46_768,
      remotePort: 6_768
    },
    ...(hostKeyFingerprint ? { hostKeyFingerprint } : {})
  }
}

function userOnServer() {
  const store = createTestStore()
  seedStore(store, {
    repos: [
      {
        id: 'repo-1',
        path: '/root/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        executionHostId: 'runtime:env-1'
      }
    ],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo-1',
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1'
        })
      ]
    },
    tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID })] }
  })
  store.getState().setRuntimeEnvironments([server(1, 'key-a')])
  return store
}

const keptWorkspaces = (store: ReturnType<typeof userOnServer>) => ({
  repos: store.getState().repos.length,
  tabs: store.getState().tabsByWorktree[WORKTREE_ID]?.length ?? 0
})

afterEach(() => resetDeferredPeerChecksForTests())

describe('an on-connect update re-pairs a managed server', () => {
  it('keeps the workspaces and tabs when the host proves the same key', () => {
    const store = userOnServer()
    store.getState().setRuntimeEnvironments([server(2, 'key-a')])
    expect(keptWorkspaces(store)).toEqual({ repos: 1, tabs: 1 })
  })

  it('keeps them when the re-read runs before the key is known, and once it arrives', () => {
    const store = userOnServer()
    store.getState().setRuntimeEnvironments([server(2)])
    expect(keptWorkspaces(store)).toEqual({ repos: 1, tabs: 1 })
    store.getState().setRuntimeEnvironments([server(2, 'key-a')])
    expect(keptWorkspaces(store)).toEqual({ repos: 1, tabs: 1 })
  })

  it('retires them once a deferred re-pair proves a different host', () => {
    const store = userOnServer()
    store.getState().setRuntimeEnvironments([server(2)])
    store.getState().setRuntimeEnvironments([server(2, 'key-reinstalled')])
    expect(keptWorkspaces(store)).toEqual({ repos: 0, tabs: 0 })
  })

  it('retires them at once when the re-pair already proves a different host', () => {
    const store = userOnServer()
    store.getState().setRuntimeEnvironments([server(2, 'key-reinstalled')])
    expect(keptWorkspaces(store)).toEqual({ repos: 0, tabs: 0 })
  })
})
