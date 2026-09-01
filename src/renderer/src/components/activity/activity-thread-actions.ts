import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentPaneThread } from './activity-thread-types'

export function createActivityThreadActions({
  allThreads,
  acknowledgeAgents,
  unacknowledgeAgents,
  setSelectedPaneKey
}: {
  allThreads: AgentPaneThread[]
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  setSelectedPaneKey: (paneKey: string | null) => void
}): {
  hasUnreadThreads: boolean
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

  const activateThreadTerminal = (thread: AgentPaneThread): void => {
    const state = useAppStore.getState()
    const worktree = getWorktreeMapFromState(state).get(thread.worktree.id)
    if (!worktree) {
      return
    }
    // Why: retained-agent threads can outlive their tab; without a live tab, reorienting the workspace and focusing a dead tab id would just confuse the user.
    const liveTabs = state.tabsByWorktree[worktree.id] ?? []
    const hasLiveTab = liveTabs.some((t) => t.id === thread.tab.id)
    if (!hasLiveTab) {
      return
    }
    if (state.activeRepoId !== worktree.repoId) {
      state.setActiveRepo(worktree.repoId)
    }
    if (state.activeWorktreeId !== worktree.id) {
      state.setActiveWorktree(worktree.id)
    }
    state.setActiveTabType('terminal')
    const parsed = parsePaneKey(thread.paneKey)
    activateTabAndFocusPane(
      thread.tab.id,
      parsed && parsed.tabId === thread.tab.id ? parsed.leafId : null,
      { scrollToBottomIfOutputSinceLastView: true }
    )
  }

  const selectThread = (thread: AgentPaneThread): void => {
    setSelectedPaneKey(thread.paneKey)
    activateThreadTerminal(thread)
  }

  const jumpToWorkspace = (thread: AgentPaneThread): void => {
    const state = useAppStore.getState()
    if (!getWorktreeMapFromState(state).has(thread.worktree.id)) {
      return
    }
    markThreadRead(thread)
    activateAndRevealWorktree(thread.worktree.id)
  }

  const hasUnreadThreads = allThreads.some((thread) => thread.unread)

  const markAllThreadsRead = (): void => {
    const unreadKeys = allThreads.filter((t) => t.unread).map((t) => t.paneKey)
    if (unreadKeys.length === 0) {
      return
    }
    acknowledgeAgents(unreadKeys)
  }

  return {
    hasUnreadThreads,
    markThreadUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead
  }
}
