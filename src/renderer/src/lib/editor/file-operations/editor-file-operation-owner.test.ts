// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { getEditorFileOperationContext } from './editor-file-operation-owner'

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const worktreeId = 'repo::/remote/repo'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    settings: { activeRuntimeEnvironmentId: 'hub-b' } as never,
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set()
  })
})

describe('editor file operation owner', () => {
  it('rejects a restored external SSH file after its target changes', () => {
    useAppStore.setState({
      repos: [{ id: 'repo', connectionId: 'ssh-replacement' } as never],
      worktreesByRepo: {
        repo: [{ id: worktreeId, repoId: 'repo', path: '/remote/repo' } as never]
      },
      sshConnectionStates: new Map([
        [
          'ssh-replacement',
          {
            targetId: 'ssh-replacement',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 1
          }
        ]
      ])
    })

    expect(() =>
      getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId, externalSshTargetId: 'ssh-original' },
        '/remote/repo'
      )
    ).toThrow('Reopen the file')
  })
})

afterEach(() => vi.unstubAllGlobals())
