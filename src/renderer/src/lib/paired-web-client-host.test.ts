import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFileExplorerOperationOwnerFromState } from '@/components/right-sidebar/file-explorer-operation-owner'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { resolveTerminalHostOwnership } from './terminal-worktree-route'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

const ENV = 'web-env'
const WT = 'repo-1::/srv/proj'

function webState(overrides: Record<string, unknown> = {}): never {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    runtimeEnvironments: [{ id: ENV }],
    runtimeEnvironmentCatalogHydrated: true,
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: `runtime:${ENV}` }],
    worktreesByRepo: {
      'repo-1': [
        { id: WT, repoId: 'repo-1', hostId: `runtime:${ENV}`, runtimeOwnerEnvironmentId: ENV }
      ]
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    ...overrides
  } as never
}

const UNSTAMPED_LOCAL_ROW = {
  worktreesByRepo: { 'repo-1': [{ id: WT, repoId: 'repo-1', hostId: 'local' }] }
}

describe('a paired web client routes every owner through its server (#9047)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('routes a workspace the server calls local to the server, never to the browser', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    for (const state of [
      webState(),
      webState({ activeWorktreeId: WT, activeWorkspaceExecutionHostId: 'local' }),
      webState(UNSTAMPED_LOCAL_ROW)
    ]) {
      expect(getRuntimeEnvironmentIdForWorktree(state, WT)).toBe(ENV)
      expect(resolveTerminalHostOwnership(state, WT, 'spawn')).toEqual({
        kind: 'runtime',
        runtimeEnvironmentId: ENV
      })
      expect(getFileExplorerOperationOwnerFromState(state, WT)).toMatchObject({
        kind: 'runtime',
        environmentId: ENV
      })
    }
  })

  it('starts setup terminals and local folder workspaces on the server', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    expect(
      resolveTerminalHostOwnership(webState(), 'ephemeral-setup-terminal:panel-1', 'spawn')
    ).toEqual({ kind: 'runtime', runtimeEnvironmentId: ENV })
    const folderState = webState({
      folderWorkspaces: [{ id: 'folder-1', executionHostId: 'local', connectionId: null }]
    })
    expect(getRuntimeEnvironmentIdForWorktree(folderState, folderWorkspaceKey('folder-1'))).toBe(
      ENV
    )
  })

  it('keeps an SSH target as the place and the server as the transport', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const state = webState({ activeWorktreeId: WT, activeWorkspaceExecutionHostId: 'ssh:target-1' })
    expect(getFileExplorerOperationOwnerFromState(state, WT)).toEqual({
      kind: 'runtime',
      environmentId: ENV,
      executionHostId: 'ssh:target-1'
    })
  })

  it('still refuses an id two hosts publish instead of guessing one', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const state = webState({
      worktreesByRepo: {
        'repo-1': [
          { id: WT, repoId: 'repo-1', hostId: 'local' },
          { id: WT, repoId: 'repo-1', hostId: 'ssh:target-1' }
        ]
      }
    })
    expect(getRuntimeEnvironmentIdForWorktree(state, WT)).toBeNull()
  })

  it('leaves a desktop window local workspace on this computer', () => {
    const state = webState(UNSTAMPED_LOCAL_ROW)
    expect(getRuntimeEnvironmentIdForWorktree(state, WT)).toBeNull()
    expect(resolveTerminalHostOwnership(state, WT, 'spawn').kind).toBe('local-or-ssh')
  })
})
