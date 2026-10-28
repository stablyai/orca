import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { revealFloatingWorkspacePanel } from '@/lib/floating-workspace-panel-reveal'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { jumpToWorktreeFromSidebar } from '@/lib/worktree-jump-navigation'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type { AppState } from '@/store/types'
import type { AgentPaneThread } from './activity-thread-types'

// Use the scope filter’s focused-host fallback; local would misroute hostless runtime-owned workspaces.
function getActivityThreadExecutionHostId(
  thread: AgentPaneThread,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return getWorktreeExecutionHostId(thread.worktree, thread.repo ?? undefined, defaultHostId)
}

type ActivityThreadWorkspaceCatalog = Pick<
  AppState,
  'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces' | 'floatingWorkspacePath'
> & { defaultHostId: ExecutionHostId }

function readActivityThreadWorkspaceCatalog(): ActivityThreadWorkspaceCatalog {
  const state = useAppStore.getState()
  return { ...state, defaultHostId: getSettingsFocusedExecutionHostId(state.settings) }
}

export function hasActivityThreadWorkspace(
  thread: AgentPaneThread,
  catalog: ActivityThreadWorkspaceCatalog = readActivityThreadWorkspaceCatalog()
): boolean {
  return Boolean(
    findKnownWorktreeById(
      catalog,
      thread.worktree.id,
      getActivityThreadExecutionHostId(thread, catalog.defaultHostId)
    )
  )
}

export function createActivityThreadActions({
  getMarkAllReadThreads,
  acknowledgeAgents,
  unacknowledgeAgents,
  setSelectedPaneKey
}: {
  /** Read current badge-coherent threads through a stable handler; Mark all read ignores search/scope so the badge reaches zero. */
  getMarkAllReadThreads: () => AgentPaneThread[]
  acknowledgeAgents: (paneKeys: string[], reads?: undefined, intent?: 'explicit') => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  setSelectedPaneKey: (paneKey: string | null) => void
}): {
  markThreadRead: (thread: AgentPaneThread) => void
  markThreadUnread: (thread: AgentPaneThread) => void
  markThreadsRead: (threads: readonly AgentPaneThread[]) => void
  markThreadsUnread: (threads: readonly AgentPaneThread[]) => void
  selectThread: (thread: AgentPaneThread) => void
  jumpToWorkspace: (thread: AgentPaneThread) => void
  markAllThreadsRead: () => void
} {
  const markThreadsRead = (threads: readonly AgentPaneThread[]): void => {
    acknowledgeAgents(
      threads.map((thread) => thread.paneKey),
      undefined,
      'explicit'
    )
  }

  const markThreadsUnread = (threads: readonly AgentPaneThread[]): void => {
    unacknowledgeAgents(threads.map((thread) => thread.paneKey))
  }

  const markThreadRead = (thread: AgentPaneThread): void => markThreadsRead([thread])

  const markThreadUnread = (thread: AgentPaneThread): void => markThreadsUnread([thread])

  const activateThreadTarget = (thread: AgentPaneThread): void => {
    const isFloatingTerminal = thread.worktree.id === FLOATING_TERMINAL_WORKTREE_ID
    const executionHostId = getActivityThreadExecutionHostId(
      thread,
      getSettingsFocusedExecutionHostId(useAppStore.getState().settings)
    )
    // Activate before probing residency: cold SSH tabs are revived/seeded here; probing first made remote row clicks no-ops (#16731).
    if (
      !isFloatingTerminal &&
      activateAndRevealWorkspace(thread.worktree.id, {
        executionHostId,
        revealInSidebar: false,
        clearSidebarFilters: false
      }) === false
    ) {
      return
    }
    if (
      activateStructuredAgentSessionTab({ worktreeId: thread.worktree.id, tabId: thread.tab.id })
    ) {
      if (isFloatingTerminal) {
        revealFloatingWorkspacePanel(useAppStore.getState())
      }
      return
    }
    // Read post-activation: the tab this thread points at may have only just been revived.
    const activated = useAppStore.getState()
    const liveTabs = activated.tabsByWorktree[thread.worktree.id] ?? []
    if (!liveTabs.some((tab) => tab.id === thread.tab.id)) {
      // Retained threads may outlive their tab; keep the workspace activated without focusing an unrelated sibling.
      return
    }
    // Floating tabs have no catalog workspace; reveal their panel without changing the main workspace.
    if (isFloatingTerminal) {
      revealFloatingWorkspacePanel(activated)
    }
    activated.setActiveTabType('terminal', thread.worktree.id)
    const parsed = parsePaneKey(thread.paneKey)
    activateTabAndFocusPane(
      thread.tab.id,
      parsed && parsed.tabId === thread.tab.id ? parsed.leafId : null,
      { flashFocusedPane: true, scrollToBottomIfOutputSinceLastView: true }
    )
  }

  const selectThread = (thread: AgentPaneThread): void => {
    setSelectedPaneKey(thread.paneKey)
    activateThreadTarget(thread)
  }

  const jumpToWorkspace = (thread: AgentPaneThread): void => {
    const catalog = readActivityThreadWorkspaceCatalog()
    if (!hasActivityThreadWorkspace(thread, catalog)) {
      return
    }
    markThreadRead(thread)
    jumpToWorktreeFromSidebar(thread.worktree.id, {
      executionHostId: getActivityThreadExecutionHostId(thread, catalog.defaultHostId)
    })
  }

  const markAllThreadsRead = (): void => {
    const unreadKeys = getMarkAllReadThreads()
      .filter((t) => t.unread)
      .map((t) => t.paneKey)
    if (unreadKeys.length === 0) {
      return
    }
    acknowledgeAgents(unreadKeys, undefined, 'explicit')
  }

  return {
    markThreadRead,
    markThreadUnread,
    markThreadsRead,
    markThreadsUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead
  }
}
