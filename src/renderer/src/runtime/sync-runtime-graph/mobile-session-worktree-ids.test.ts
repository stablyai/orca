import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  getLiveFolderWorkspaceIds,
  getMobileSessionWorktreeIds
} from './mobile-session-dirty-workspaces'

describe('mobile-session worktree id caching', () => {
  it('reuses the same Set when workspace-keyed map references are unchanged and rebuilds on change', () => {
    const tabsByWorktree = { 'r::/a': [], 'r::/b': [] } as unknown as AppState['tabsByWorktree']
    const groupsByWorktree = { 'r::/b': [], 'r::/c': [] } as unknown as AppState['groupsByWorktree']
    const unifiedTabsByWorktree = { 'r::/d': [] } as unknown as AppState['unifiedTabsByWorktree']
    const browserTabsByWorktree = {} as AppState['browserTabsByWorktree']
    const openFiles = [{ worktreeId: 'r::/e' }] as unknown as AppState['openFiles']
    const folderWorkspaces = [{ id: 'f1' }] as unknown as AppState['folderWorkspaces']

    const state = {
      tabsByWorktree,
      groupsByWorktree,
      unifiedTabsByWorktree,
      browserTabsByWorktree,
      openFiles,
      folderWorkspaces
    } as unknown as AppState

    const firstIds = getMobileSessionWorktreeIds(state, browserTabsByWorktree)
    const secondIds = getMobileSessionWorktreeIds(state, browserTabsByWorktree)
    expect(secondIds).toBe(firstIds)
    expect([...firstIds].sort()).toEqual(['r::/a', 'r::/b', 'r::/c', 'r::/d', 'r::/e'])

    const firstFolders = getLiveFolderWorkspaceIds(state)
    expect(getLiveFolderWorkspaceIds(state)).toBe(firstFolders)
    expect([...firstFolders]).toEqual(['f1'])

    const nextState = {
      ...state,
      tabsByWorktree: { ...tabsByWorktree, 'r::/f': [] }
    } as unknown as AppState
    const thirdIds = getMobileSessionWorktreeIds(nextState, browserTabsByWorktree)
    expect(thirdIds).not.toBe(firstIds)
    expect(thirdIds.has('r::/f')).toBe(true)
  })
})
