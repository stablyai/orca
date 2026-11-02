import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { logicalTabIdOf } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { WindowTabContentRequest } from '../../../shared/window-tab-content'
import { switchedTab } from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { recordUnlistedCreatedChat } from './structured-agent-session-unlisted-created-chats'
import { retireSwitchedStructuredAgentSessionContent } from '@/runtime/structured-agent-session-tab-retirement'
import { sourceTabGroupInView, sourceTabHoldsSelection } from './switch-source-selection'

/**
 * The window's half of a switch: the tab holding just the switch's source keeps its id, group,
 * place, pin and color and now holds the destination (the one condition, `switchedTab`). Answers
 * which tab and whether it does; false changes nothing.
 */
export function setWindowTabContent(
  request: Omit<WindowTabContentRequest, 'requestId' | 'expiresAt'>
): {
  retargeted: boolean
  tabId?: string
} {
  const { worktreeId, expectSource, content } = request
  const state = useAppStore.getState()
  const destination =
    content.kind === 'terminal'
      ? { kind: 'terminal' as const, terminalId: content.terminalId }
      : { kind: 'agent-session' as const, sessionId: content.sessionId }
  const found = switchedTab(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).map((entry) => ({
      id: entry.id,
      kind: entry.contentType,
      entityId: entry.entityId,
      leafCount:
        entry.contentType === 'terminal'
          ? Math.max(
              1,
              collectLayoutLeafIdsInOrder(
                state.terminalLayoutsByTabId[entry.entityId]?.root ?? null
              ).length
            )
          : 0,
      tab: entry
    })),
    request.tabId,
    expectSource,
    destination
  )
  if (!found || found.done || request.decide) {
    return found ? { retargeted: true, tabId: found.tab.id } : { retargeted: false }
  }
  const { tab } = found.tab
  const tabId = tab.id
  // Read before the change: the user is on this tab, so focus moves into what it now shows.
  const shown =
    request.focus &&
    sourceTabHoldsSelection(state, worktreeId, tab) &&
    sourceTabGroupInView(state, worktreeId, tab.groupId)
  // Kept: id, group, place, pin, color. Reset: what described the old content.
  const kept: Tab = {
    id: tab.id,
    entityId: destination.kind === 'terminal' ? destination.terminalId : destination.sessionId,
    groupId: tab.groupId,
    worktreeId: tab.worktreeId,
    ...(tab.executionHostId ? { executionHostId: tab.executionHostId } : {}),
    contentType: content.kind,
    label: content.kind === 'terminal' ? tab.label : defaultAgentChatLabel(content.agent),
    customLabel: null,
    color: tab.color,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt,
    ...(tab.isPinned ? { isPinned: true } : {}),
    ...(tab.lastFocusedAt !== undefined ? { lastFocusedAt: tab.lastFocusedAt } : {}),
    ...(content.kind === 'agent-session' ? { agentSessionAgent: content.agent } : {})
  }
  useAppStore.setState((current) => ({
    unifiedTabsByWorktree: {
      ...current.unifiedTabsByWorktree,
      [worktreeId]: (current.unifiedTabsByWorktree[worktreeId] ?? []).map((entry) =>
        entry.id === tabId ? kept : entry
      )
    }
  }))
  if (content.kind === 'terminal') {
    // The tab already names the terminal, so this adds only its records, in the tab's own group.
    const store = useAppStore.getState()
    const terminal = store.createTab(worktreeId, tab.groupId, undefined, {
      id: content.terminalId,
      initialPtyId: content.ptyId,
      initialLeafId: content.leafId,
      activate: false,
      recordInteraction: false,
      ...(content.launchAgent ? { launchAgent: content.launchAgent } : {})
    })
    store.setTabLabel(tab.id, terminal.title)
    store.setTabLayout(
      content.terminalId,
      singlePaneLayoutSnapshot(content.leafId, content.ptyId, content.title)
    )
    // As any terminal main reveals: its runtime title names the fresh content.
    if (content.title) {
      store.setTabCustomTitle(content.terminalId, content.title, { recordInteraction: false })
    }
    // The chat left with its conversation still the host's: only this window's readers go.
    if (expectSource.kind === 'agent-session') {
      retireSwitchedStructuredAgentSessionContent({
        target: { kind: 'local' },
        worktreeId,
        sessionId: expectSource.sessionId
      })
    }
    if (shown) {
      store.setActiveTab(content.terminalId)
      store.setActiveTabType('terminal', worktreeId)
      focusTerminalTabSurface(content.terminalId, content.leafId)
    } else if (useAppStore.getState().activeWorktreeId !== worktreeId) {
      requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [content.terminalId] })
    }
    return { retargeted: true, tabId }
  }
  // A list built before main records the chat must not read its absence as a close.
  recordUnlistedCreatedChat(worktreeId, content.sessionId, LOCAL_EXECUTION_HOST_ID)
  if (expectSource.kind === 'terminal') {
    // Its process already stopped; no tab holds it now, so this retires only its records (and
    // records it closed, so a late record of it can't bring it back), never Reopen Closed Tab.
    closeTerminalTab(expectSource.terminalId, {
      reason: 'cleanup',
      force: true,
      skipRunningProcessConfirm: true,
      localPtyTeardownOwnedExternally: true
    })
  }
  if (shown) {
    useAppStore.getState().setActiveTabType('agent-session', worktreeId)
    requestNativeChatComposerFocus(tab.id)
  }
  return { retargeted: true, tabId }
}

/**
 * Restart reconcile, through the same write: main's chat-tab record names tab T only once a switch
 * committed (the window already answered and T's CLI exited), so a window that restored T still
 * holding that terminal (it stopped before saving) takes the chat there. A terminal with a process
 * in this run is never taken: that is a newer switch's live CLI, not the stale half.
 */
export function reconcileSwitchedChatTabs(
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): void {
  for (const snapshot of snapshots) {
    for (const row of snapshot.tabs) {
      if (row.type !== 'agent-session' || !row.logicalTabId) {
        continue
      }
      const state = useAppStore.getState()
      const tab = state.unifiedTabsByWorktree[snapshot.worktree]?.find(
        (entry) => entry.id === row.logicalTabId
      )
      if (
        tab?.contentType !== 'terminal' ||
        (state.ptyIdsByTabId[tab.entityId]?.length ?? 0) > 0 ||
        snapshot.tabs.some(
          (other) => other.type === 'terminal' && other.ptyId && logicalTabIdOf(other) === tab.id
        )
      ) {
        continue
      }
      setWindowTabContent({
        worktreeId: snapshot.worktree,
        tabId: tab.id,
        expectSource: { kind: 'terminal', terminalId: tab.entityId },
        content: { kind: 'agent-session', sessionId: row.sessionId, agent: row.agent },
        focus: false
      })
    }
  }
}

/** A switch changes what one of this window's tabs holds; main waits for whether it did. */
export function registerWindowTabContentRequests(unsubs: (() => void)[]): void {
  if (!window.api.ui.onSetTabContent) {
    return
  }
  unsubs.push(
    window.api.ui.onSetTabContent(({ requestId, expiresAt, ...request }) => {
      try {
        // Main stopped waiting at the deadline and took this as refused: change nothing.
        const outcome =
          Date.now() >= expiresAt ? { retargeted: false } : setWindowTabContent(request)
        window.api.ui.replyTabContent?.({ requestId, ...outcome })
      } catch (error) {
        window.api.ui.replyTabContent?.({
          requestId,
          retargeted: false,
          error: error instanceof Error ? error.message : 'Tab content change failed'
        })
      }
    })
  )
}
