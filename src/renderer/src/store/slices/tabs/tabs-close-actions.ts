import { landsOnEmptiedWorktree, emptiedWorktreeLandingPatch } from './empty-worktree-landing'
export { landOnEmptiedWorktree } from './empty-worktree-landing'
import { retireWorkspaceNativeClaims } from '../../workspace-presentation-close'
import { failedWorkspaceTabCloseRestore, workspaceSourceClaims } from '../../workspace-composition'
import { retireRemovedNativeChatDraftPositions } from '@/components/native-chat/native-chat-draft-cache'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { collapseGroupLayout } from '../../../../../shared/workspace-layout/tab-group-layout-tree'
import {
  findGroupForTab,
  findTabAndWorktree,
  pickNextActiveTab,
  sanitizeRecentTabIds
} from '../tab-group-state'
import { dedupeTabOrder } from '../../../../../shared/workspace-layout/tab-order'
import { buildActiveSurfacePatch } from './tabs-surface'
import { beginStructuredAgentSessionTabClose } from '@/runtime/structured-agent-session-tab-retirement'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  shouldRetainStructuredAgentSessionLaunchTab
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-focus-intent'
import { ownsGlobalSelection } from '../../global-selection-owner'
import {
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForTab
} from '@/runtime/structured-agent-session-owner'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { removeTabsAttention } from '../workspace-attention/subject-attention-transitions'
import { settleAttentionRemovedBy } from '../workspace-attention/attention-removal-follow-up'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { closeContentTabThroughLayoutOwner } from './content-tab-close-through-layout-owner'
import { isEditorTabContentType } from '../editor/tabs/editor-tab-content-type'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { forgetDesktopCreatedServerTab } from '@/lib/desktop-created-server-tabs'

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
      forgetDesktopCreatedServerTab(tab.id)
      forgetDesktopCreatedServerTab(tab.entityId)
      const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      // Why: a tab whose group record vanished must still close; its order is the worktree's tabs.
      const groupOrder =
        group?.tabOrder ?? (state.unifiedTabsByWorktree[worktreeId] ?? []).map((item) => item.id)

      if (tab.contentType === 'terminal' && !opts?.terminalRetirementHandled) {
        const dedupedGroupOrder = dedupeTabOrder(groupOrder)
        const wasLastTab =
          dedupeTabOrder(dedupedGroupOrder.filter((id) => id !== tabId)).length === 0
        // Why: unified-only hydrated tabs still own provider sessions without a legacy row, so retire every terminal close by entity id.
        get().closeTab(tab.entityId, { recordInteraction: opts?.recordInteraction })
        return { closedTabId: tabId, wasLastTab, worktreeId }
      }

      const dedupedGroupOrder = dedupeTabOrder(groupOrder)
      const remainingOrder = dedupeTabOrder(dedupedGroupOrder.filter((id) => id !== tabId))
      const wasLastTab = remainingOrder.length === 0
      if (tab.contentType === 'agent-session') {
        const provisional =
          shouldRetainStructuredAgentSessionLaunchTab(worktreeId, tab.entityId) ||
          hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, tab.entityId)
        const target = structuredAgentSessionTargetForTab(state, tab)
        if (!tab.executionHostId || !target) {
          retireStructuredAgentSessionReadOwner(tab.entityId, null, tab.executionHostId ?? '')
        }
        if (target) {
          if (provisional) {
            clearWebSessionFocusIntentIfMatches(
              structuredAgentSessionFocusOwner(target),
              worktreeId,
              `agent-session:${tab.entityId}`
            )
          }
          const restorePlacement = failedWorkspaceTabCloseRestore(
            state,
            worktreeId,
            tab.id,
            get,
            set
          )
          for (const source of workspaceSourceClaims(state, worktreeId, tab)) {
            beginStructuredAgentSessionTabClose({
              target,
              worktreeId: source.workspaceId,
              afterFailedCloseReadback: restorePlacement,
              sessionId: tab.entityId,
              provisional,
              layoutOwner: state,
              // Switch point: main's frames draw this machine's chats, so main opens it again.
              ...(ORCA_LAYOUT_OWNER_IS_MAIN &&
              target.kind === 'local' &&
              tab.agentSessionAgent &&
              isTuiAgent(tab.agentSessionAgent)
                ? { reopen: reopenChatTab(tab.worktreeId, tab.entityId, tab.agentSessionAgent) }
                : {})
            })
          }
        } else {
          // Closing still removes the tab; no host can be named to stop its chat on.
          console.warn('[structured-agent-session] close found no owning host', tab.entityId)
        }
        // The unsent draft stays: it belongs to the conversation, which can be reopened from history.
      }
      const nextActiveTabId =
        group?.activeTabId === tabId
          ? wasLastTab
            ? null
            : pickNextActiveTab(
                dedupedGroupOrder,
                group.recentTabIds,
                tabId,
                state.unifiedTabsByWorktree[worktreeId]
              )
          : (group?.activeTabId ?? null)
      const nextRecentTabIds = sanitizeRecentTabIds(
        (group?.recentTabIds ?? []).filter((id) => id !== tabId),
        remainingOrder
      )
      const terminalEntityId = tab.contentType === 'terminal' ? tab.entityId : null

      const closeHere = (): void =>
        settleAttentionRemovedBy(set, get, () =>
          set((current) => {
            if (tab.contentType === 'agent-session') {
              current = { ...current, ...retireWorkspaceNativeClaims(current, worktreeId, tab) }
            }
            const nextTabs = (current.unifiedTabsByWorktree[worktreeId] ?? []).filter((item) => {
              if (item.id === tabId) {
                retireRemovedNativeChatDraftPositions([item], [])
              }
              return item.id !== tabId
            })
            // Bulk closes bypass terminals.closeTab, so clear entity-keyed unread markers here too.
            const nextUnreadTerminalTabs = terminalEntityId
              ? omitRecordKeys(current.unreadTerminalTabs, [terminalEntityId])
              : current.unreadTerminalTabs
            // Why: a structured chat tab owns its markers directly; nothing else retires them.
            const structuredAttention =
              tab.contentType === 'agent-session' ? removeTabsAttention(current, [tabId]) : null
            let nextGroups = (current.groupsByWorktree[worktreeId] ?? []).map((candidate) =>
              candidate.id === group?.id
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
            if (
              group &&
              wasLastTab &&
              current.layoutByWorktree[worktreeId] &&
              nextGroups.length > 1
            ) {
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
            // Unwinding a failed create added no tab; preserve the original selection instead of landing on welcome.
            const shouldDeactivateWorktree =
              !opts?.preserveWorktreeSelection &&
              landsOnEmptiedWorktree(current, worktreeId, nextTabs.length)
            return {
              unifiedTabsByWorktree: { ...current.unifiedTabsByWorktree, [worktreeId]: nextTabs },
              groupsByWorktree: {
                ...current.groupsByWorktree,
                [worktreeId]: nextGroups
              },
              layoutByWorktree: nextLayoutByWorktree,
              activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
              // Avoid no-op unread allocations that wake full-state selectors.
              ...(nextUnreadTerminalTabs !== current.unreadTerminalTabs
                ? { unreadTerminalTabs: nextUnreadTerminalTabs }
                : {}),
              ...structuredAttention,
              // Why: closing the last tab can leave the worktree selected but render-empty, so write the landing-state fallback directly.
              ...(shouldDeactivateWorktree ? emptiedWorktreeLandingPatch(current, worktreeId) : {}),
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
        )
      // Switch point: main closes an editor, browser, chat or simulator tab first; its frame drops it.
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        closeContentTabThroughLayoutOwner(get, tab, {
          nextActiveTabId,
          closeHere,
          // An editor close lands through closeFile, which owns its content.
          ...(isEditorTabContentType(tab.contentType) || opts?.preserveWorktreeSelection
            ? {}
            : { landIfEmptied: () => landOnEmptiedWorktree(set, get, worktreeId) }),
          // A chat tab owns its markers; nothing else retires them.
          ...(tab.contentType === 'agent-session'
            ? {
                closed: () =>
                  settleAttentionRemovedBy(
                    set,
                    get,
                    () => set((current) => removeTabsAttention(current, [tabId])),
                    { tabsBefore: state }
                  )
              }
            : {})
        })
      ) {
        if (opts?.recordInteraction !== false) {
          get().recordFeatureInteraction?.('terminal-tabs')
        }
        return { closedTabId: tabId, wasLastTab, worktreeId }
      }
      closeHere()
      if (opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
      return { closedTabId: tabId, wasLastTab, worktreeId }
    }
  }
}

// Last user-close lands on welcome; failed-create cleanup preserves selection.
/** Main opens the chat where it opens any chat this host lists: a host-kept chat comes back. */
function reopenChatTab(worktreeId: string, sessionId: string, agent: TuiAgent): () => void {
  return () =>
    void import('@/lib/structured-agent-session-launch-surface').then(
      ({ openStructuredAgentSessionProvisionalTab }) =>
        openStructuredAgentSessionProvisionalTab({
          worktreeId,
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          sessionId,
          agent,
          activate: false
        })
    )
}
