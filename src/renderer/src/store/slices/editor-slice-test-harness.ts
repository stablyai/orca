import { withSessionSourceTestWrites } from '@/lib/test-support/session-source-test-store'
import { vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
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

export function createEditorStore() {
  // Only the editor slice + activeWorktreeId are needed for these tests.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture initializes only the editor slices under test.
  return createStore<AppState>()(
    withSessionSourceTestWrites(
      (...args) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture initializes only the editor slices under test.
        ({
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
          ...createEditorSlice(...args)
        }) as unknown as AppState
    )
  )
}

export function createEditorTabsStore() {
  return createStore<AppState>()(
    withSessionSourceTestWrites(
      (...args) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test controls the the declared fixture domain fixture and intentionally supplies only the scenario's members.
        ({
          activeWorktreeId: 'wt-1',
          tabsByWorktree: {},
          browserTabsByWorktree: {},
          activeBrowserTabId: null,
          activeBrowserTabIdByWorktree: {},
          activeTabId: null,
          activeTabIdByWorktree: {},
          tabBarOrderByWorktree: {},
          setTabBarOrder: (worktreeId: string, order: string[]) =>
            args[0]((state) => ({
              tabBarOrderByWorktree: { ...state.tabBarOrderByWorktree, [worktreeId]: order }
            })),
          repos: [{ id: 'repo-1', path: '/repo' }],
          worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
          folderWorkspaces: [],
          projectGroups: [],
          recordFeatureInteraction: vi.fn(),
          ...createTabsSlice(...args),
          ...createEditorSlice(...args)
        }) as unknown as AppState
    )
  )
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
