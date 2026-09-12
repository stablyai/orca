import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import {
  dispatchTerminalPaneSplitRequest,
  queueTerminalPaneSplitRequest
} from '@/components/terminal-pane/terminal-pane-split-request-routing'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'
import {
  activateTerminalInitiatedWorktree,
  focusTerminalInitiatedTab
} from './terminal-command-state'

type RuntimeTerminalSplitRequest = SplitTerminalPaneDetail & { worktreeId?: string }

type TerminalOwnershipEvidence = {
  owners: Set<string>
  ambiguous: boolean
}

function collectTerminalOwnershipEvidence(
  tabsByWorktree: AppState['tabsByWorktree'],
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'],
  tabId: string
): TerminalOwnershipEvidence {
  const owners = new Set<string>()
  let ambiguous = false

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree ?? {})) {
    let matches = 0
    for (const tab of tabs) {
      if (tab.id === tabId) {
        matches += 1
      }
    }
    if (matches > 0) {
      owners.add(worktreeId)
      ambiguous ||= matches > 1
    }
  }

  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    let matches = 0
    for (const tab of tabs) {
      if (tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)) {
        matches += 1
      }
    }
    if (matches > 0) {
      owners.add(worktreeId)
      ambiguous ||= matches > 1
    }
  }

  return { owners, ambiguous }
}

function resolveSplitTargetWorktreeId(request: RuntimeTerminalSplitRequest): string | null {
  const state = useAppStore.getState()
  const evidence = collectTerminalOwnershipEvidence(
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    request.tabId
  )
  if (evidence.ambiguous) {
    return null
  }
  if (request.worktreeId) {
    if (evidence.owners.has(request.worktreeId)) {
      return request.worktreeId
    }
    // A tab seen under another owner makes the hint stale; do not cross-route it.
    if (evidence.owners.size > 0) {
      return null
    }
    // During startup the ownership rows can hydrate after this IPC event. Keep the
    // explicit host hint so the bounded replay queue can wake the right worktree.
    return request.worktreeId
  }
  return evidence.owners.size === 1 ? [...evidence.owners][0]! : null
}

export function routeRuntimeTerminalSplitRequest(request: RuntimeTerminalSplitRequest): void {
  const worktreeId = resolveSplitTargetWorktreeId(request)
  if (!worktreeId) {
    return
  }
  const detail: SplitTerminalPaneDetail = {
    tabId: request.tabId,
    worktreeId,
    paneRuntimeId: request.paneRuntimeId,
    direction: request.direction,
    command: request.command,
    sourceLeafId: request.sourceLeafId,
    telemetrySource: request.telemetrySource,
    newLeafId: request.newLeafId
  }
  if (hasRegisteredRuntimeTerminalTab(request.tabId, worktreeId)) {
    dispatchTerminalPaneSplitRequest(detail)
    return
  }
  queueTerminalPaneSplitRequest(detail)
  requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [request.tabId] })
}

export function registerTerminalUiRoutingIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(window.api.ui.onSplitTerminal(routeRuntimeTerminalSplitRequest))

  unsubs.push(
    window.api.ui.onRenameTerminal(({ tabId, title }) => {
      useAppStore.getState().setTabCustomTitle(tabId, title)
    })
  )

  unsubs.push(
    window.api.ui.onFocusTerminal(
      ({
        tabId,
        worktreeId,
        leafId,
        ackPaneKeyOnSuccess,
        flashFocusedPane,
        scrollToBottomIfOutputSinceLastView
      }) => {
        const store = useAppStore.getState()
        activateTerminalInitiatedWorktree(store, worktreeId)
        store.setActiveTab(tabId)
        store.revealWorktreeInSidebar(worktreeId)
        if (ackPaneKeyOnSuccess || flashFocusedPane || scrollToBottomIfOutputSinceLastView) {
          activateTabAndFocusPane(tabId, leafId ?? null, {
            ...(ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess } : {}),
            ...(flashFocusedPane ? { flashFocusedPane: true } : {}),
            ...(scrollToBottomIfOutputSinceLastView
              ? { scrollToBottomIfOutputSinceLastView: true }
              : {})
          })
          return
        }
        focusTerminalInitiatedTab(tabId, leafId, worktreeId)
      }
    )
  )

  unsubs.push(
    window.api.ui.onFocusEditorTab(({ tabId, worktreeId }) => {
      const store = useAppStore.getState()
      const tab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find((item) => item.id === tabId)
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, tabId)
      // Why: chat-completion focus is a courtesy reveal, not navigation — never yank the user
      // back into a workspace they deliberately left.
      if (tab?.contentType === 'agent-session' && store.activeWorktreeId !== worktreeId) {
        return
      }
      if (!tab) {
        if (browserTarget) {
          // Why: older/mobile fallback snapshots identify browser tabs by workspace id when no unified tab wrapper exists.
          store.setActiveWorktree(worktreeId)
          store.markWorktreeVisited(worktreeId)
          store.setActiveView('terminal')
          store.setActiveBrowserTab(browserTarget.workspaceId)
          store.setActiveTabType('browser')
          store.revealWorktreeInSidebar(worktreeId)
        }
        return
      }
      store.setActiveWorktree(worktreeId)
      store.markWorktreeVisited(worktreeId)
      store.setActiveView('terminal')
      store.focusGroup(worktreeId, tab.groupId)
      store.activateTab(tab.id)
      if (tab.contentType === 'agent-session') {
        store.setActiveTabType('agent-session')
      } else if (browserTarget) {
        // Why: browser tabs need their own active-page state, not the editor file activation path.
        store.setActiveBrowserTab(browserTarget.workspaceId)
        store.setActiveTabType('browser')
      } else {
        store.setActiveFile(tab.entityId)
        store.setActiveTabType('editor')
      }
      store.revealWorktreeInSidebar(worktreeId)
    })
  )
}
