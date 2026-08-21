import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

import { captureRuntimeTerminalDropOwner } from './terminal-drop-runtime-owner'

describe('runtime terminal drop owner', () => {
  beforeEach(() => {
    mocks.state = {
      settings: { activeRuntimeEnvironmentId: 'hub-a' },
      runtimeEnvironments: [{ id: 'hub-a' }],
      runtimeEnvironmentCatalogHydrated: true,
      removedRuntimeEnvironmentIds: new Set(),
      repos: [{ id: 'repo-a', executionHostId: 'runtime:hub-a', connectionId: null }],
      worktreesByRepo: {
        'repo-a': [
          {
            id: 'worktree-a',
            repoId: 'repo-a',
            hostId: 'ssh:ssh-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          }
        ]
      },
      detectedWorktreesByRepo: {},
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map([
        ['hub-a', { connectionStates: new Map([['ssh-a', { connectionGeneration: 17 }]]) }]
      ])
    }
  })

  it('rejects a staged upload after the HUB SSH session token changes', () => {
    const owner = captureRuntimeTerminalDropOwner('worktree-a')
    expect(owner).toMatchObject({
      runtimeEnvironmentId: 'hub-a',
      expectedSshTargetId: 'ssh-a',
      expectedSshConnectionGeneration: 17
    })

    mocks.state.sshStateByEnvironment = new Map([
      ['hub-a', { connectionStates: new Map([['ssh-a', { connectionGeneration: 18 }]]) }]
    ])

    expect(() => owner?.assertCurrent()).toThrow('Terminal upload host changed; retry the drop.')
  })
})
