import { useAppStore } from '@/store'
import type { WindowTabContentRequest } from '../../../shared/window-tab-content'
import { switchedTab } from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { recordUnlistedCreatedChat } from './structured-agent-session-unlisted-created-chats'
import { retireSwitchedStructuredAgentSessionContent } from '@/runtime/structured-agent-session-tab-retirement'
import { sourceTabGroupInView, sourceTabHoldsSelection } from './switch-source-selection'
import { tabHolding } from './switched-tab-holding'

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
  const kept = tabHolding(tab, content)
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
