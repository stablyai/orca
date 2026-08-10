// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import {
  getTerminalParkWorktreeOwner,
  useTerminalParkWorktreeOwnerState
} from './terminal-park-worktree-owner'

const WORKTREE_ID = 'repo-1::/worktree'

describe('useTerminalParkWorktreeOwnerState', () => {
  let originalState: ReturnType<typeof useAppStore.getState>

  beforeEach(() => {
    originalState = useAppStore.getState()
    useAppStore.setState({
      repos: [{ id: 'repo-1', connectionId: 'ssh-a' } as Repo],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo-1',
            hostId: 'ssh:ssh-a',
            runtimeOwnerEnvironmentId: 'env-a'
          })
        ]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(originalState, true)
  })

  it('refreshes owner evidence without rerendering for unrelated store writes', () => {
    const { result } = renderHook(() => useTerminalParkWorktreeOwnerState())
    const initialState = result.current
    expect(getTerminalParkWorktreeOwner(result.current, WORKTREE_ID)).toEqual({
      kind: 'runtime',
      environmentId: 'env-a'
    })

    act(() => useAppStore.setState({ activeView: 'settings' }))
    expect(result.current).toBe(initialState)

    act(() => useAppStore.setState({ repos: [{ id: 'repo-1', connectionId: 'ssh-b' } as Repo] }))
    expect(result.current).not.toBe(initialState)
    expect(getTerminalParkWorktreeOwner(result.current, WORKTREE_ID)).toEqual({
      kind: 'runtime',
      environmentId: 'env-a'
    })

    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          'repo-1': [
            makeWorktree({
              id: WORKTREE_ID,
              repoId: 'repo-1',
              hostId: 'ssh:ssh-b',
              runtimeOwnerEnvironmentId: 'env-b'
            })
          ]
        }
      })
    )
    expect(getTerminalParkWorktreeOwner(result.current, WORKTREE_ID)).toEqual({
      kind: 'runtime',
      environmentId: 'env-b'
    })
  })
})

describe('getTerminalParkWorktreeOwner', () => {
  const baseState = {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    settings: { activeRuntimeEnvironmentId: null }
  }

  it('tags explicit local, SSH, runtime, missing, and ambiguous worktree owners', () => {
    const owner = (hostId: ExecutionHostId, runtimeOwnerEnvironmentId?: string) => ({
      id: WORKTREE_ID,
      repoId: 'repo-1',
      hostId,
      ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
    })
    expect(
      getTerminalParkWorktreeOwner(
        { ...baseState, worktreesByRepo: { 'repo-1': [owner('local')] } },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'local' })
    expect(
      getTerminalParkWorktreeOwner(
        { ...baseState, worktreesByRepo: { 'repo-1': [owner('ssh:ssh-1')] } },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'ssh', connectionId: 'ssh-1' })
    expect(
      getTerminalParkWorktreeOwner(
        {
          ...baseState,
          worktreesByRepo: { 'repo-1': [owner('ssh:ssh-1', 'env-1')] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'runtime', environmentId: 'env-1' })
    expect(getTerminalParkWorktreeOwner(baseState, 'missing::/worktree')).toEqual({
      kind: 'unknown'
    })
    expect(
      getTerminalParkWorktreeOwner(
        {
          ...baseState,
          worktreesByRepo: { 'repo-1': [owner('local'), owner('runtime:env-1')] }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'ambiguous' })
  })

  it('withholds implicit local authority until runtime ownership hydrates', () => {
    const state = {
      ...baseState,
      runtimeEnvironmentCatalogHydrated: false,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1' }] }
    }
    expect(getTerminalParkWorktreeOwner(state, WORKTREE_ID)).toEqual({ kind: 'unknown' })
    expect(
      getTerminalParkWorktreeOwner(
        { ...state, runtimeEnvironmentCatalogHydrated: true },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'local' })
  })

  it('keeps the sole legacy runtime owner but rejects a mixed-runtime guess', () => {
    const state = {
      ...baseState,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1' }] },
      settings: { activeRuntimeEnvironmentId: 'env-legacy' }
    }
    expect(
      getTerminalParkWorktreeOwner(
        { ...state, runtimeEnvironments: [{ id: 'env-legacy' }] },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'runtime', environmentId: 'env-legacy' })
    expect(
      getTerminalParkWorktreeOwner(
        { ...state, runtimeEnvironments: [{ id: 'env-legacy' }, { id: 'env-other' }] },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'unknown' })
  })

  it('resolves folder owners without treating pre-hydration absence as local', () => {
    const folderId = 'folder-1'
    const worktreeId = folderWorkspaceKey(folderId)
    const workspace = { id: folderId, projectGroupId: 'group-1' }
    const state = {
      ...baseState,
      runtimeEnvironmentCatalogHydrated: false,
      folderWorkspaces: [workspace],
      projectGroups: [{ id: 'group-1' }]
    }
    expect(getTerminalParkWorktreeOwner(state, worktreeId)).toEqual({ kind: 'unknown' })
    expect(
      getTerminalParkWorktreeOwner(
        {
          ...state,
          folderWorkspaces: [{ ...workspace, executionHostId: 'ssh:ssh-folder' }]
        },
        worktreeId
      )
    ).toEqual({ kind: 'ssh', connectionId: 'ssh-folder' })
    expect(
      getTerminalParkWorktreeOwner(
        {
          ...state,
          restoredRuntimeHostIdByWorkspaceSessionKey: { [worktreeId]: 'runtime:env-restored' }
        },
        worktreeId
      )
    ).toEqual({ kind: 'runtime', environmentId: 'env-restored' })
    expect(
      getTerminalParkWorktreeOwner(
        {
          ...state,
          folderWorkspaces: [
            { ...workspace, executionHostId: 'local' },
            { ...workspace, executionHostId: 'runtime:env-rival' }
          ]
        },
        worktreeId
      )
    ).toEqual({ kind: 'ambiguous' })
  })
})
