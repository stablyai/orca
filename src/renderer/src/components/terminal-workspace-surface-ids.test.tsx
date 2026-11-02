// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from './worktree-jump/worktree-jump-palette-test-fixtures'
import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'

const initialState = useAppStore.getInitialState()

describe('workspace surface ids', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.restoreAllMocks()
  })

  it('keeps the id array and id set stable when a worktree write re-identifies the surfaces', () => {
    const repo = makeRepo()
    const first = makeWorktree('alpha', 'Alpha')
    const second = makeWorktree('beta', 'Beta')
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [first, second] } })

    const { result, rerender } = renderHook(() => useTerminalWorkspaceFoundation())
    const initialSurfaces = result.current.workspaceSurfaces
    const initialIds = result.current.workspaceSurfaceIds
    const initialIdSet = result.current.workspaceSurfaceIdSet
    expect(initialIds).toEqual([first.id, second.id])

    useAppStore.setState({
      worktreesByRepo: {
        [repo.id]: [
          { ...first, lastActivityAt: Date.now() },
          { ...second, lastActivityAt: Date.now() }
        ]
      }
    })
    rerender()

    expect(result.current.workspaceSurfaces).not.toBe(initialSurfaces)
    expect(result.current.workspaceSurfaceIds).toBe(initialIds)
    expect(result.current.workspaceSurfaceIdSet).toBe(initialIdSet)

    useAppStore.setState({ worktreesByRepo: { [repo.id]: [first] } })
    rerender()
    expect(result.current.workspaceSurfaceIds).not.toBe(initialIds)
    expect(result.current.workspaceSurfaceIdSet).not.toBe(initialIdSet)
    expect(result.current.workspaceSurfaceIds).toEqual([first.id])
  })
  it('keeps the surface projection stable across a git-worktree switch', () => {
    const repo = makeRepo()
    const worktrees = Array.from({ length: 423 }, (_, index) =>
      makeWorktree(`repo-1::/worktree-${index}`, `Workspace ${index}`)
    )
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: worktrees },
      activeWorktreeId: worktrees[0].id
    })

    const { result } = renderHook(() => useTerminalWorkspaceFoundation())
    const surfaces = result.current.workspaceSurfaces
    const ids = result.current.workspaceSurfaceIds
    const idSet = result.current.workspaceSurfaceIdSet
    expect(surfaces).toHaveLength(423)

    // Active-ID-only switches without a folder tie-break must reuse the surface projection and ID array.
    for (let index = 1; index < 10; index += 1) {
      act(() => {
        useAppStore.setState({ activeWorktreeId: worktrees[index].id })
      })
      expect(result.current.renderedActiveWorktreeId).toBe(worktrees[index].id)
      expect(result.current.workspaceSurfaces).toBe(surfaces)
      expect(result.current.workspaceSurfaceIds).toBe(ids)
      expect(result.current.workspaceSurfaceIdSet).toBe(idSet)
    }
  })

  it('still re-projects when the active folder workspace owns the collision tie-break', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const localFolder: FolderWorkspace = {
      id: 'folder-shared',
      projectGroupId: 'group-shared',
      name: 'orca',
      folderPath: '/work/orca-local',
      connectionId: null,
      executionHostId: 'local',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    const runtimeFolder: FolderWorkspace = {
      ...localFolder,
      folderPath: '/remote/orca',
      executionHostId: 'runtime:env-1'
    }
    useAppStore.setState({
      folderWorkspaces: [localFolder, runtimeFolder],
      activeWorktreeId: 'folder:folder-shared',
      activeWorkspaceExecutionHostId: 'runtime:env-1'
    })

    const { result } = renderHook(() => useTerminalWorkspaceFoundation())
    expect(result.current.workspaceSurfaces).toEqual([
      { id: 'folder:folder-shared', path: '/remote/orca' }
    ])

    // Leaving folder scope must drop its host tie-break and recompute first-wins selection.
    act(() => {
      useAppStore.setState({
        activeWorktreeId: 'repo-1::/worktree-0',
        activeWorkspaceExecutionHostId: null
      })
    })
    expect(result.current.workspaceSurfaces).toEqual([
      { id: 'folder:folder-shared', path: '/work/orca-local' }
    ])
    warn.mockRestore()
  })

  it('stops idle worktree writes from re-firing surface-keyed terminal effects', () => {
    const repo = makeRepo()
    const worktrees = Array.from({ length: 20 }, (_, index) =>
      makeWorktree(`wt-${index}`, `Workspace ${index}`)
    )
    useAppStore.setState({ worktreesByRepo: { [repo.id]: worktrees } })

    const fires = { surfaceKeyed: 0, idKeyed: 0 }
    renderHook(() => {
      const foundation = useTerminalWorkspaceFoundation()
      useEffect(() => {
        fires.surfaceKeyed += 1
      }, [foundation.workspaceSurfaces])
      useEffect(() => {
        fires.idKeyed += 1
      }, [foundation.workspaceSurfaceIds])
    })
    expect(fires).toEqual({ surfaceKeyed: 1, idKeyed: 1 })

    // Model idle activity/status writes that preserve every workspace ID.
    for (let write = 0; write < 100; write += 1) {
      act(() => {
        useAppStore.setState({
          worktreesByRepo: {
            [repo.id]: worktrees.map((worktree) => ({ ...worktree, lastActivityAt: write }))
          }
        })
      })
    }

    expect(fires.surfaceKeyed).toBe(101)
    expect(fires.idKeyed).toBe(1)
  })
})
