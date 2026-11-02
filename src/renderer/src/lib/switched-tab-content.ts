import { useAppStore } from '@/store'
import type { WindowTabContentRequest } from '../../../shared/window-tab-content'
import {
  chatTabIdAmong,
  switchedTab
} from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { recordUnlistedCreatedChat } from './structured-agent-session-unlisted-created-chats'
import {
  publishedChatRowId,
  retireSwitchedStructuredAgentSessionContent
} from '@/runtime/structured-agent-session-tab-retirement'
import { sourceTabGroupInView, sourceTabHoldsSelection } from './switch-source-selection'
import { tabHolding } from './switched-tab-holding'

/**
 * The window's half of a switch: the tab holding just the switch's source keeps its id, group,
 * place, pin and color and now holds the destination (the one condition, `switchedTab`). Answers
 * which tab and whether it does; false changes nothing.
 */
export function setWindowTabContent(request: Omit<WindowTabContentRequest, 'requestId'>): {
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
    destination,
    // Only deciding searches by content; a change, and a reading, is bound to the decided tab.
    !request.decide || request.exact === true
  )
  if (!found || found.done || request.decide) {
    return found
      ? { retargeted: true, tabId: found.tab.id }
      : content.kind === 'agent-session'
        ? { retargeted: false, tabId: windowChatTabId(worktreeId, content.sessionId) }
        : { retargeted: false }
  }
  const { tab } = found.tab
  const tabId = tab.id
  // Read before the change: the user is on this tab, so focus moves into what it now shows.
  const shown =
    request.focus &&
    sourceTabHoldsSelection(state, worktreeId, tab) &&
    sourceTabGroupInView(state, worktreeId, tab.groupId)
  const kept = tabHolding(tab, content)
  // The row the chat publishes, read while this tab still holds it.
  const chatRowId =
    expectSource.kind === 'agent-session'
      ? publishedChatRowId(state, { kind: 'local' }, worktreeId, tab)
      : null
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
    if (expectSource.kind === 'agent-session' && chatRowId) {
      retireSwitchedStructuredAgentSessionContent({
        target: { kind: 'local' },
        worktreeId,
        sessionId: expectSource.sessionId,
        rowId: chatRowId
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
  // The conversation has one chat tab: one it already had here goes, its chat living on in this
  // tab (never a close of the chat, nor a Reopen Closed Tab entry).
  for (const duplicate of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (
      duplicate.id !== tabId &&
      duplicate.contentType === 'agent-session' &&
      duplicate.entityId === content.sessionId
    ) {
      useAppStore.getState().closeUnifiedTab(duplicate.id, {
        chatRetirementHandled: true,
        preserveWorktreeSelection: true,
        recordInteraction: false
      })
    }
  }
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

/** Where this window would open a chat a switch's tab didn't take: the tab holding it, else its
 *  usual id, else the next free one, as this window has its tabs now (main's copy can trail). */
export function windowChatTabId(worktreeId: string, sessionId: string): string {
  return chatTabIdAmong(
    (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => ({
      id: tab.id,
      holds: tab.contentType === 'agent-session' && tab.entityId === sessionId
    })),
    sessionId
  )
}
