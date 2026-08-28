import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { ActivityBarPosition } from '../types/open-file'
import type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView
} from '../../../../../../shared/ui-chrome-types'
import { defaultFileSearchState } from '../search/file-search-state'

export type RightSidebarState = {
  rightSidebarOpen: boolean
  rightSidebarWidth: number
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
  rightSidebarRouteRequestId: number
  rightSidebarTabByWorktree: Record<string, ActiveRightSidebarTab>
  rightSidebarExplorerViewByWorktree: Record<string, RightSidebarExplorerView>
  activityBarPosition: ActivityBarPosition
  toggleRightSidebar: () => void
  setRightSidebarOpen: (open: boolean) => void
  setRightSidebarWidth: (width: number) => void
  setRightSidebarTab: (tab: ActiveRightSidebarTab) => void
  setRightSidebarExplorerView: (view: RightSidebarExplorerView) => void
  showRightSidebarFiles: () => void
  showRightSidebarSearch: (payload?: {
    query?: string | null
    includePattern?: string | null
  }) => void
  setActivityBarPosition: (position: ActivityBarPosition) => void
}

export function createRightSidebarState(set: EditorSet, _get: EditorGet): RightSidebarState {
  return {
    rightSidebarOpen: false,
    rightSidebarWidth: 280,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    rightSidebarRouteRequestId: 0,
    rightSidebarTabByWorktree: {},
    rightSidebarExplorerViewByWorktree: {},
    activityBarPosition: 'top',
    toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
    setRightSidebarOpen: (open) => set({ rightSidebarOpen: open }),
    setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),
    setRightSidebarTab: (tab) =>
      set((s) => ({
        rightSidebarTab: tab,
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
        ...(tab === 'explorer' ? { rightSidebarExplorerView: 'files' as const } : {})
      })),
    setRightSidebarExplorerView: (view) =>
      set((s) => ({
        rightSidebarExplorerView: view,
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
        ...(s.activeWorktreeId
          ? {
              rightSidebarExplorerViewByWorktree: {
                ...s.rightSidebarExplorerViewByWorktree,
                [s.activeWorktreeId]: view
              }
            }
          : {})
      })),
    showRightSidebarFiles: () =>
      set((s) => ({
        rightSidebarOpen: true,
        rightSidebarTab: 'explorer',
        rightSidebarExplorerView: 'files',
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
        ...(s.activeWorktreeId
          ? {
              rightSidebarExplorerViewByWorktree: {
                ...s.rightSidebarExplorerViewByWorktree,
                [s.activeWorktreeId]: 'files'
              }
            }
          : {})
      })),
    showRightSidebarSearch: (payload) =>
      set((s) => {
        const next = {
          rightSidebarOpen: true,
          rightSidebarTab: 'explorer' as const,
          rightSidebarExplorerView: 'search' as const,
          rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
          ...(s.activeWorktreeId
            ? {
                rightSidebarExplorerViewByWorktree: {
                  ...s.rightSidebarExplorerViewByWorktree,
                  [s.activeWorktreeId]: 'search' as const
                }
              }
            : {})
        }
        if (!s.activeWorktreeId) {
          return next
        }

        const query = payload?.query?.trim() ? payload.query : null
        const includePattern = payload?.includePattern?.trim() ? payload.includePattern : null
        const current = s.fileSearchStateByWorktree[s.activeWorktreeId] || defaultFileSearchState()
        const shouldSeed = Boolean(query || (includePattern && current.query.trim()))
        const shouldFocus = !shouldSeed
        const nextSearchState = {
          ...current,
          ...(query ? { query } : {}),
          ...(includePattern ? { includePattern } : {}),
          ...(shouldSeed
            ? {
                results: null,
                resultOwner: null,
                loading: false,
                collapsedFiles: new Set<string>(),
                seedRequestId: (current.seedRequestId ?? 0) + 1
              }
            : {}),
          ...(shouldFocus ? { focusRequestId: (current.focusRequestId ?? 0) + 1 } : {})
        }

        return {
          ...next,
          fileSearchStateByWorktree: {
            ...s.fileSearchStateByWorktree,
            [s.activeWorktreeId]: nextSearchState
          }
        }
      }),
    setActivityBarPosition: (position) => set({ activityBarPosition: position })
  }
}
