// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

import { useAppStore } from '@/store'

import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'

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
})
