import type { EditorGet, EditorSet } from '../editor/types/editor-set-get'
import type {
  ActiveRightSidebarTab,
  ActivityBarPosition,
  RightSidebarExplorerView
} from '../../../../../shared/ui-chrome/ui-chrome-types'
import { defaultFileSearchState } from '../editor/search/file-search-state'
import {
  nativeChatAuxiliaryParentKey,
  type NativeChatAuxiliaryState
} from './native-chat-auxiliary-state'

export type RightSidebarState = NativeChatAuxiliaryState & {
  rightSidebarOpen: boolean
  rightSidebarWidth: number
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
  rightSidebarRouteRequestId: number
  /** Set to ask the Agent Session Search panel to widen to all computers and focus its box. */
  aiVaultSearchFocusRequested: boolean
  rightSidebarTabByWorktree: Record<string, ActiveRightSidebarTab>
  rightSidebarExplorerViewByWorktree: Record<string, RightSidebarExplorerView>
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
  /** Opens this conversation's side chats without selecting a main tab. */
  showRightSidebarSideChat: () => void
  clearAiVaultSearchFocusRequest: () => void
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
    rightSidebarEffectiveTab: null,
    nativeChatAuxiliaryByParent: {},
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
    // Settings sends the user here; the panel owns scope, so this asks rather than writes.
    showAiVaultSearch: () =>
      set((s) => ({
        rightSidebarOpen: true,
        rightSidebarTab: 'vault' as const,
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1,
        aiVaultSearchFocusRequested: true
      })),
    showRightSidebarSideChat: () =>
      set((s) => ({
        rightSidebarOpen: true,
        rightSidebarTab: 'side-chat' as const,
        rightSidebarRouteRequestId: s.rightSidebarRouteRequestId + 1
      })),
    addNativeChatAuxiliaryChild: (parent, child) =>
      set((s) => {
        const key = nativeChatAuxiliaryParentKey(parent)
        const current = s.nativeChatAuxiliaryByParent[key]
        const conversation = {
          key,
          parentSessionId: parent.sessionId,
          parentTabId: parent.tabId,
          worktreeId: parent.worktreeId,
          target: parent.target,
          agent: child.agent,
          children: [...(current?.children ?? []), child],
          activeChildSessionId: child.sessionId
        }
        return {
          nativeChatAuxiliaryByParent: {
            ...s.nativeChatAuxiliaryByParent,
            [key]: conversation
          }
        }
      }),
    setActiveNativeChatAuxiliaryChild: (key, sessionId) =>
      set((s) => {
        const current = s.nativeChatAuxiliaryByParent[key]
        if (
          !current ||
          current.activeChildSessionId === sessionId ||
          (sessionId !== null && !current.children.some((child) => child.sessionId === sessionId))
        ) {
          return {}
        }
        return {
          nativeChatAuxiliaryByParent: {
            ...s.nativeChatAuxiliaryByParent,
            [key]: { ...current, activeChildSessionId: sessionId }
          }
        }
      }),
    removeNativeChatAuxiliaryChild: (key, sessionId) =>
      set((s) => {
        const current = s.nativeChatAuxiliaryByParent[key]
        if (!current) {
          return {}
        }
        if (!current.children.some((child) => child.sessionId === sessionId)) {
          return {}
        }
        const children = current.children.filter((child) => child.sessionId !== sessionId)
        // Closing or losing the active child never routes to a sibling on its own.
        const activeChildSessionId =
          current.activeChildSessionId === sessionId ? null : current.activeChildSessionId
        return {
          nativeChatAuxiliaryByParent: {
            ...s.nativeChatAuxiliaryByParent,
            [key]: { ...current, children, activeChildSessionId }
          }
        }
      }),
    clearAiVaultSearchFocusRequest: () => set({ aiVaultSearchFocusRequested: false }),
    setRightSidebarEffectiveTab: (tab) =>
      set((s) => (s.rightSidebarEffectiveTab === tab ? {} : { rightSidebarEffectiveTab: tab })),
    setActivityBarPosition: (position) => set({ activityBarPosition: position })
  }
}
