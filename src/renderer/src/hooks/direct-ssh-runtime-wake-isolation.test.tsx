// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeTab, makeWorktree } from '@/store/slices/store-test-helpers'
import { useRemoteRuntimeRecoveryTriggers } from '@/runtime/use-remote-runtime-recovery-triggers'
import { registerDirectSshWakeRouting } from './direct-ssh-state-routing'

const { retryAllRemoteRuntimePtyRecoveriesNowMock } = vi.hoisted(() => ({
  retryAllRemoteRuntimePtyRecoveriesNowMock: vi.fn()
}))

vi.mock('@/components/terminal-pane/remote-runtime-pty-recovery-state', () => ({
  retryAllRemoteRuntimePtyRecoveriesNow: retryAllRemoteRuntimePtyRecoveriesNowMock
}))

function authority(): DirectSshAuthority {
  return {
    targetId: 'direct-target',
    providerEpoch: 'direct-epoch' as SshProviderEpoch,
    connectionGeneration: 7
  }
}

describe('runtime and direct SSH wake isolation', () => {
  const retryConnectionsNow = vi.fn(() => Promise.resolve())
  const resumeCallbacks = new Set<() => void>()
  const onSystemResumed = vi.fn((callback: () => void) => {
    resumeCallbacks.add(callback)
    return () => resumeCallbacks.delete(callback)
  })

  beforeEach(() => {
    retryConnectionsNow.mockClear()
    retryAllRemoteRuntimePtyRecoveriesNowMock.mockClear()
    onSystemResumed.mockClear()
    resumeCallbacks.clear()
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: { retryConnectionsNow },
      ui: { onSystemResumed }
    }
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('advances both runtime backoffs and one exact direct wake without rebumping a healthy pane', () => {
    const currentAuthority = authority()
    const directWorktreeId = 'repo-direct::/work/direct'
    const runtimeWorktreeId = 'repo-runtime::/work/runtime'
    const directPtyId = 'ssh:direct-target@@pty-live'
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo-direct',
          path: '/work/direct',
          displayName: 'direct',
          badgeColor: '#000',
          addedAt: 1,
          connectionId: 'direct-target',
          executionHostId: 'ssh:direct-target'
        },
        {
          id: 'repo-runtime',
          path: '/work/runtime',
          displayName: 'runtime',
          badgeColor: '#000',
          addedAt: 1,
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: {
        'repo-direct': [
          makeWorktree({
            id: directWorktreeId,
            repoId: 'repo-direct',
            path: '/work/direct',
            hostId: 'ssh:direct-target'
          })
        ],
        'repo-runtime': [
          makeWorktree({
            id: runtimeWorktreeId,
            repoId: 'repo-runtime',
            path: '/work/runtime',
            hostId: 'ssh:runtime-owned-target',
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      },
      tabsByWorktree: {
        [directWorktreeId]: [
          makeTab({
            id: 'tab-direct',
            worktreeId: directWorktreeId,
            ptyId: directPtyId,
            generation: 0
          })
        ],
        [runtimeWorktreeId]: [
          makeTab({ id: 'tab-runtime', worktreeId: runtimeWorktreeId, ptyId: null })
        ]
      },
      ptyIdsByTabId: { 'tab-direct': [directPtyId], 'tab-runtime': [] },
      directSshLivePtyBindingByTabId: {
        'tab-direct': {
          attemptId: 'direct-attempt' as never,
          authority: currentAuthority,
          tabGeneration: 0,
          ptyId: directPtyId
        }
      },
      sshConnectionStates: new Map([
        [
          'direct-target',
          {
            targetId: 'direct-target',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: currentAuthority.providerEpoch,
            connectionGeneration: currentAuthority.connectionGeneration
          }
        ]
      ]),
      sshStateByEnvironment: new Map([
        [
          'env-1',
          {
            connectionStates: new Map([
              [
                'runtime-owned-target',
                {
                  targetId: 'runtime-owned-target',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  providerEpoch: 'runtime-epoch' as SshProviderEpoch,
                  connectionGeneration: 3
                }
              ]
            ]),
            targetLabels: new Map([['runtime-owned-target', 'runtime target']]),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    })
    const wakePreparation = vi.fn()
    const correctedCounts: number[] = []
    const unregisterDirectWake = registerDirectSshWakeRouting({
      getConnectionStates: () => store.getState().sshConnectionStates,
      wakeAuthority: (nextAuthority) => {
        correctedCounts.push(store.getState().retryDirectSshTargetPanes(nextAuthority, 1_000))
        wakePreparation(nextAuthority)
      },
      onSystemResumed
    })
    const { unmount } = renderHook(() => useRemoteRuntimeRecoveryTriggers())

    window.dispatchEvent(new Event('online'))

    expect(retryConnectionsNow).toHaveBeenCalledTimes(1)
    expect(retryAllRemoteRuntimePtyRecoveriesNowMock).toHaveBeenCalledTimes(1)
    expect(wakePreparation).toHaveBeenCalledOnce()
    expect(wakePreparation).toHaveBeenCalledWith(currentAuthority)
    expect(correctedCounts).toEqual([0])
    expect(store.getState().tabsByWorktree[directWorktreeId][0]).toMatchObject({
      generation: 0,
      ptyId: directPtyId
    })
    expect(store.getState().tabsByWorktree[runtimeWorktreeId][0].generation ?? 0).toBe(0)
    expect(store.getState().directSshPaneRetryByTabId).toEqual({})

    unregisterDirectWake()
    unmount()
    window.dispatchEvent(new Event('online'))
    expect(retryConnectionsNow).toHaveBeenCalledTimes(1)
    expect(wakePreparation).toHaveBeenCalledTimes(1)
  })
})
