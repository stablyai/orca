import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { collapseGroupLayout } from './tabs-layout'
import {
  dedupeTabOrder,
  findGroupForTab,
  findTabAndWorktree,
  pickNextActiveTab,
  sanitizeRecentTabIds
} from '../tab-group-state'
import { buildActiveSurfacePatch } from './tabs-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { beginStructuredAgentSessionTabClose } from '@/runtime/structured-agent-session-tab-retirement'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  shouldRetainStructuredAgentSessionLaunchTab
} from '@/lib/structured-agent-session-launch-registry'
import { structuredAgentSessionTabId } from '../../../../../shared/structured-agent-session-projection'
import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-focus-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import { ownsGlobalSelection } from '../../global-selection-owner'

export function createTabsCloseActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'closeUnifiedTab'> {
  return {
    closeUnifiedTab: (tabId, opts) => {
      const state = get()
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return null
      }
      const { tab, worktreeId } = found
      const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      if (!group) {
        return null
      }

      if (tab.contentType === 'terminal' && !opts?.terminalRetirementHandled) {
        const dedupedGroupOrder = dedupeTabOrder(group.tabOrder)
        const wasLastTab =
          dedupeTabOrder(dedupedGroupOrder.filter((id) => id !== tabId)).length === 0
        // Why: unified-only hydrated tabs still own provider sessions without a legacy row, so retire every terminal close by entity id.
        get().closeTab(tab.entityId, { recordInteraction: opts?.recordInteraction })
        return { closedTabId: tabId, wasLastTab, worktreeId }
      }

      const dedupedGroupOrder = dedupeTabOrder(group.tabOrder)
      const remainingOrder = dedupeTabOrder(dedupedGroupOrder.filter((id) => id !== tabId))
      const wasLastTab = remainingOrder.length === 0
      if (tab.contentType === 'agent-session') {
        const provisional =
          shouldRetainStructuredAgentSessionLaunchTab(worktreeId, tab.entityId) ||
          hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, tab.entityId)
        if (provisional) {
          clearWebSessionFocusIntentIfMatches(
            { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
            worktreeId,
            `agent-session:${tab.entityId}`
          )
        }
        beginStructuredAgentSessionTabClose({
          target: getActiveRuntimeTarget({
            activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
          }),
          worktreeId,
          tabId: tab.id,
          sessionId: tab.entityId,
          provisional
        })
        get().clearNativeChatLaunchDraft(structuredAgentSessionTabId(tab.entityId))
      }
      // Why: on closing the active tab, walk the MRU stack to the previously-active tab; pickNextActiveTab falls back to the neighbor.
      const nextActiveTabId =
        group.activeTabId === tabId
          ? wasLastTab
            ? null
            : pickNextActiveTab(dedupedGroupOrder, group.recentTabIds, tabId)
          : group.activeTabId
      const nextRecentTabIds = sanitizeRecentTabIds(
        (group.recentTabIds ?? []).filter((id) => id !== tabId),
        remainingOrder
      )
      const terminalEntityId = tab.contentType === 'terminal' ? tab.entityId : null

      set((current) => {
        const nextTabs = (current.unifiedTabsByWorktree[worktreeId] ?? []).filter(
          (item) => item.id !== tabId
        )
        // Why: close-to-right/others bypass terminals.closeTab, so clear the entityId-keyed unread flag here or a stale dot leaks.
        let nextUnreadTerminalTabs = current.unreadTerminalTabs
        if (terminalEntityId && current.unreadTerminalTabs[terminalEntityId]) {
          nextUnreadTerminalTabs = { ...current.unreadTerminalTabs }
          delete nextUnreadTerminalTabs[terminalEntityId]
        }
        let nextGroups = (current.groupsByWorktree[worktreeId] ?? []).map((candidate) =>
          candidate.id === group.id
            ? {
                ...candidate,
                activeTabId: nextActiveTabId,
                tabOrder: remainingOrder,
                recentTabIds: nextRecentTabIds
              }
            : candidate
        )
        let nextLayoutByWorktree = current.layoutByWorktree
        let nextActiveGroupIdByWorktree = current.activeGroupIdByWorktree
        if (wasLastTab && current.layoutByWorktree[worktreeId] && nextGroups.length > 1) {
          nextGroups = nextGroups.filter((candidate) => candidate.id !== group.id)
          const collapsedState = collapseGroupLayout(
            current.layoutByWorktree,
            current.activeGroupIdByWorktree,
            worktreeId,
            group.id,
            nextGroups[0]?.id ?? null
          )
          nextLayoutByWorktree = collapsedState.layoutByWorktree
          nextActiveGroupIdByWorktree = collapsedState.activeGroupIdByWorktree
        }
        // Why: the landing fallback answers "the user emptied this worktree". An unwound create
        // never added a tab, so it must leave the selection exactly as the click found it.
        const shouldDeactivateWorktree =
          !opts?.preserveWorktreeSelection &&
          current.activeWorktreeId === worktreeId &&
          nextTabs.length === 0 &&
          (current.tabsByWorktree[worktreeId] ?? []).length === 0 &&
          (current.browserTabsByWorktree[worktreeId] ?? []).length === 0 &&
          !current.openFiles.some((file) => file.worktreeId === worktreeId)
        return {
          unifiedTabsByWorktree: { ...current.unifiedTabsByWorktree, [worktreeId]: nextTabs },
          groupsByWorktree: {
            ...current.groupsByWorktree,
            [worktreeId]: nextGroups
          },
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
          // Why: skip writing unreadTerminalTabs when the reference is unchanged, avoiding a no-op alloc that re-runs full-state selectors.
          ...(nextUnreadTerminalTabs !== current.unreadTerminalTabs
            ? { unreadTerminalTabs: nextUnreadTerminalTabs }
            : {}),
          // Why: closing the last tab can leave the worktree selected but render-empty, so write the landing-state fallback directly.
          ...(shouldDeactivateWorktree
            ? {
                activeWorktreeId: null,
                activeWorkspaceKey: null,
                activeWorkspaceExecutionHostId: null,
                activeTabId: null,
                activeBrowserTabId: null,
                activeFileId: null,
                activeTabType: 'terminal' as const,
                activeTabIdByWorktree: {
                  ...current.activeTabIdByWorktree,
                  [worktreeId]: null
                },
                activeBrowserTabIdByWorktree: {
                  ...current.activeBrowserTabIdByWorktree,
                  [worktreeId]: null
                },
                activeFileIdByWorktree: {
                  ...current.activeFileIdByWorktree,
                  [worktreeId]: null
                },
                activeTabTypeByWorktree: {
                  ...current.activeTabTypeByWorktree,
                  [worktreeId]: 'terminal'
                }
              }
            : {}),
          ...(!shouldDeactivateWorktree && ownsGlobalSelection(current, worktreeId)
            ? buildActiveSurfacePatch(
                {
                  ...current,
                  unifiedTabsByWorktree: {
                    ...current.unifiedTabsByWorktree,
                    [worktreeId]: nextTabs
                  },
                  groupsByWorktree: {
                    ...current.groupsByWorktree,
                    [worktreeId]: nextGroups
                  },
                  layoutByWorktree: nextLayoutByWorktree,
                  activeGroupIdByWorktree: nextActiveGroupIdByWorktree
                },
                worktreeId,
                nextActiveGroupIdByWorktree[worktreeId] ?? null
              )
            : {})
        }
      })

      if (opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
      return { closedTabId: tabId, wasLastTab, worktreeId }
    }
  }
}
