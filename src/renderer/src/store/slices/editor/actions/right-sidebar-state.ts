import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { ActivityBarPosition } from '../types/open-file'
import type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView
} from '../../../../../../shared/ui-chrome-types'
import { defaultFileSearchState } from '../search/file-search-state'
import type { RuntimeClientTarget } from '../../../../runtime/runtime-client-target'

/** A chat visual shown in place of the active tab. Identity only, never the HTML. */
export type RightSidebarVisualRoute = {
  target: RuntimeClientTarget
  sessionId: string
  messageId: string
  file: string
  title: string | null
  /** The chat tab and workspace that own it; the panel closes once either is gone or left. */
  tabId: string
  worktreeId: string
}

/**
 * In memory only: never persisted or mirrored to other clients. Shown while no later tab route was
 * requested, so picking any tab returns the sidebar to it without clearing this explicitly.
 */
export type RightSidebarVisualState = RightSidebarVisualRoute & {
  routeRequestId: number
  /** The sidebar was closed before the visual opened it; closing the visual closes it again. */
  reopenedSidebar: boolean
  /** The sidebar's width while it shows the visual; the stored width is left untouched. */
  width: number | null
}

export type RightSidebarState = {
  rightSidebarOpen: boolean
  rightSidebarWidth: number
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
  rightSidebarRouteRequestId: number
  /** Set to ask the Agent Session Search panel to widen to all computers and focus its box. */
  aiVaultSearchFocusRequested: boolean
  rightSidebarTabByWorktree: Record<string, ActiveRightSidebarTab>
  rightSidebarExplorerViewByWorktree: Record<string, RightSidebarExplorerView>
  rightSidebarVisual: RightSidebarVisualState | null
  /** In memory: the tab the mounted sidebar renders, which differs from rightSidebarTab when that tab is hidden here. */
  rightSidebarEffectiveTab: ActiveRightSidebarTab | null
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
  showAiVaultSearch: () => void
  clearAiVaultSearchFocusRequest: () => void
  openRightSidebarVisual: (route: RightSidebarVisualRoute) => void
  closeRightSidebarVisual: () => void
  setRightSidebarVisualWidth: (width: number) => void
  setRightSidebarEffectiveTab: (tab: ActiveRightSidebarTab | null) => void
  setActivityBarPosition: (position: ActivityBarPosition) => void
}

export function createRightSidebarState(set: EditorSet, _get: EditorGet): RightSidebarState {
  return {
    rightSidebarOpen: false,
    rightSidebarWidth: 280,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    rightSidebarRouteRequestId: 0,
    aiVaultSearchFocusRequested: false,
    rightSidebarTabByWorktree: {},
    rightSidebarExplorerViewByWorktree: {},
    rightSidebarVisual: null,
    rightSidebarEffectiveTab: null,
    activityBarPosition: 'top',
    toggleRightSidebar: () =>
      set((s) => ({
        rightSidebarOpen: !s.rightSidebarOpen,
        ...(s.rightSidebarOpen ? { rightSidebarVisual: null } : {})
      })),
    setRightSidebarOpen: (open) =>
      set({ rightSidebarOpen: open, ...(open ? {} : { rightSidebarVisual: null }) }),
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
    // Settings sends the user here; the panel owns scope, so this asks rather than writes.
    showAiVaultSearch: () =>
      set((s) => ({
        rightSidebarOpen: true,
        rightSidebarTab: 'vault' as const,
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
        aiVaultSearchFocusRequested: true
      })),
    clearAiVaultSearchFocusRequest: () => set({ aiVaultSearchFocusRequested: false }),
    openRightSidebarVisual: (route) =>
      set((s) => {
        const current = selectVisibleRightSidebarVisual(s)
        return {
          rightSidebarOpen: true,
          rightSidebarVisual: {
            ...route,
            routeRequestId: s.rightSidebarRouteRequestId,
            reopenedSidebar: current ? current.reopenedSidebar : !s.rightSidebarOpen,
            width: current?.width ?? null
          }
        }
      }),
    closeRightSidebarVisual: () =>
      set((s) => ({
        rightSidebarVisual: null,
        ...(selectVisibleRightSidebarVisual(s)?.reopenedSidebar ? { rightSidebarOpen: false } : {})
      })),
    setRightSidebarVisualWidth: (width) =>
      set((s) => {
        const visual = selectVisibleRightSidebarVisual(s)
        return visual ? { rightSidebarVisual: { ...visual, width } } : {}
      }),
    setRightSidebarEffectiveTab: (tab) =>
      set((s) => (s.rightSidebarEffectiveTab === tab ? {} : { rightSidebarEffectiveTab: tab })),
    setActivityBarPosition: (position) => set({ activityBarPosition: position })
  }
}

/** The visual the sidebar shows now, or null once a tab route superseded it or it was closed. */
export function selectVisibleRightSidebarVisual(
  state: Pick<
    RightSidebarState,
    'rightSidebarVisual' | 'rightSidebarRouteRequestId' | 'rightSidebarOpen'
  >
): RightSidebarVisualState | null {
  const visual = state.rightSidebarVisual
  return visual &&
    state.rightSidebarOpen &&
    visual.routeRequestId === state.rightSidebarRouteRequestId
    ? visual
    : null
}
