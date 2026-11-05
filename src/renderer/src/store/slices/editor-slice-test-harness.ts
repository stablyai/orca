import { vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from './editor'
import { createTabsSlice } from './tabs'
import type { AppState } from '../types'

/** The tab-bar maps switch-on editor paths read; a store without the tabs slice needs them too. */
export function emptyTabLayoutState(): Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree'
> {
  return { unifiedTabsByWorktree: {}, groupsByWorktree: {}, layoutByWorktree: {} }
}

export function createEditorStore(): StoreApi<AppState> {
  // Only the editor slice + activeWorktreeId are needed for these tests.
  // oxlint-disable-next-line typescript/no-explicit-any, typescript/consistent-type-assertions -- SAFETY: a partial store; tests read only the slices it builds.
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    ...emptyTabLayoutState(),
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    repos: [{ id: 'repo-1', path: '/repo' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
    folderWorkspaces: [],
    projectGroups: [],
    recordFeatureInteraction: vi.fn(),
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

export function createEditorTabsStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    setTabBarOrder: (worktreeId: string, order: string[]) =>
      args[0]((state: AppState) => ({
        tabBarOrderByWorktree: { ...state.tabBarOrderByWorktree, [worktreeId]: order }
      })),
    repos: [{ id: 'repo-1', path: '/repo' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
    folderWorkspaces: [],
    projectGroups: [],
    recordFeatureInteraction: vi.fn(),
    ...createTabsSlice(...(args as Parameters<typeof createTabsSlice>)),
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

export async function flushAsyncRemoteRefresh(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

export function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}
