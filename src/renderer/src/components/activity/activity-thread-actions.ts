import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { jumpToWorktreeFromSidebar } from '@/lib/worktree-jump-navigation'
import { useAppStore } from '@/store'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type { AppState } from '@/store/types'
import type { AgentPaneThread } from './activity-thread-types'

// Same focused-host fallback the Agents scope filter uses; defaulting to `local` here would
// look up a hostless runtime-owned workspace on the wrong host and silently drop the jump.
function getActivityThreadExecutionHostId(
  thread: AgentPaneThread,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return getWorktreeExecutionHostId(thread.worktree, thread.repo ?? undefined, defaultHostId)
}

type ActivityThreadWorkspaceCatalog = Pick<
  AppState,
  'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'
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
  /** Getter (not a snapshot) so the handlers keep one identity for the row memo
   *  bail-outs while bulk actions still see the current thread set. This is the
   *  badge-coherent set (child-filter only), not the search/scope-narrowed one,
   *  so Mark all read always drives the Agents badge to zero. */
  getMarkAllReadThreads: () => AgentPaneThread[]
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  setSelectedPaneKey: (paneKey: string | null) => void
}): {
  markThreadRead: (thread: AgentPaneThread) => void
  markThreadUnread: (thread: AgentPaneThread) => void
  selectThread: (thread: AgentPaneThread) => void
  jumpToWorkspace: (thread: AgentPaneThread) => void
  markAllThreadsRead: () => void
} {
  const markThreadRead = (thread: AgentPaneThread): void => {
    acknowledgeAgents([thread.paneKey])
  }

  const markThreadUnread = (thread: AgentPaneThread): void => {
    unacknowledgeAgents([thread.paneKey])
  }

  const activateThreadTarget = (thread: AgentPaneThread): void => {
    const executionHostId = getActivityThreadExecutionHostId(
      thread,
      getSettingsFocusedExecutionHostId(useAppStore.getState().settings)
    )
    // Why the full sequence (not bare setActiveWorktree): a cold-parked thread — the normal
    // state of an SSH session that was never revived — has no resident tab until
    // resumeSleepingAgentSessionsForWorktree/ensureWorktreeHasInitialTerminal run inside here.
    // Probing tab residency first is what made a remote row click a silent no-op (#16731).
    if (activateAndRevealWorkspace(thread.worktree.id, { executionHostId }) === false) {
      return
    }
    if (
      activateStructuredAgentSessionTab({ worktreeId: thread.worktree.id, tabId: thread.tab.id })
    ) {
      return
    }
    // Read post-activation: the tab this thread points at may have only just been revived.
    const activated = useAppStore.getState()
    const liveTabs = activated.tabsByWorktree[thread.worktree.id] ?? []
    if (!liveTabs.some((tab) => tab.id === thread.tab.id)) {
      // Retained threads outlive their tab; the workspace is still activated, but there is
      // no pane to focus and focusing a sibling would be worse than focusing nothing.
      return
    }
    activated.setActiveTabType('terminal')
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
    acknowledgeAgents(unreadKeys)
  }

  return {
    markThreadRead,
    markThreadUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead
  }
}
