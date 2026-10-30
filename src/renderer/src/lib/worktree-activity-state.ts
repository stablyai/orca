import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { resolveAgentStatusWorktreeId } from '../../../shared/agent-status-worktree-attribution'
import {
  liveAgentStatusOf,
  strongerLiveAgentStatus,
  type LiveAgentWorktreeStatus
} from '../../../shared/sidebar-list/workspace-activity-facts'

type TerminalLikeTab = Pick<TerminalTab, 'id'>
type BrowserLikeTab = { id: string }

type TabsByWorktree = Record<string, readonly TerminalLikeTab[]>
type PtyIdsByTabId = Record<string, string[]>
type BrowserTabsByWorktree = Record<string, readonly BrowserLikeTab[]>
export type { LiveAgentWorktreeStatus }

const EMPTY_WORKTREE_IDS: ReadonlySet<string> = new Set()

/** Keep only fresh in-progress agents; disconnected SSH/completed headless rows can outlive actual open sessions. */
export function getWorktreeIdsWithLiveAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | null | undefined,
  tabsByWorktree: TabsByWorktree | null | undefined,
  now: number
): Set<string> {
  return new Set(getLiveAgentStatusByWorktreeId(agentStatusByPaneKey, tabsByWorktree, now).keys())
}

export function getLiveAgentStatusByWorktreeId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | null | undefined,
  tabsByWorktree: TabsByWorktree | null | undefined,
  now: number
): Map<string, LiveAgentWorktreeStatus> {
  const entries = Object.values(agentStatusByPaneKey ?? {}).filter((entry) =>
    isFreshNonDoneAgentStatus(entry, now)
  )
  if (entries.length === 0) {
    return new Map()
  }
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }
  const result = new Map<string, LiveAgentWorktreeStatus>()
  for (const entry of entries) {
    const worktreeId = resolveAgentStatusWorktreeId(entry, worktreeIdByTabId)
    if (worktreeId) {
      result.set(
        worktreeId,
        strongerLiveAgentStatus(result.get(worktreeId), liveAgentStatusOf(entry))
      )
    }
  }
  return result
}

export function hasActiveWorkspaceActivity(
  worktreeId: string,
  tabsByWorktree: TabsByWorktree | null | undefined,
  ptyIdsByTabId: PtyIdsByTabId | null | undefined,
  browserTabsByWorktree: BrowserTabsByWorktree | null | undefined,
  worktreeIdsWithLiveAgent: ReadonlySet<string>,
  worktreeIdsWithStructuredChat: ReadonlySet<string> = EMPTY_WORKTREE_IDS
): boolean {
  const tabs = tabsByWorktree?.[worktreeId] ?? []
  const hasLiveTerminal =
    ptyIdsByTabId != null && tabs.some((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))
  const hasBrowser = (browserTabsByWorktree?.[worktreeId] ?? []).length > 0
  // Why: a running agent keeps the workspace visible through brief PTY gaps
  // such as an SSH reconnect or an unmounted remote pane. #7197
  const hasLiveAgent = worktreeIdsWithLiveAgent.has(worktreeId)
  // Structured chats lack PTYs/tabsByWorktree entries; their visibility evidence must remain separate from terminal signals.
  const hasStructuredChat = worktreeIdsWithStructuredChat.has(worktreeId)
  return hasLiveTerminal || hasBrowser || hasLiveAgent || hasStructuredChat
}

export function isInactiveWorkspace(
  worktreeId: string,
  tabsByWorktree: TabsByWorktree | null | undefined,
  ptyIdsByTabId: PtyIdsByTabId | null | undefined,
  browserTabsByWorktree: BrowserTabsByWorktree | null | undefined,
  worktreeIdsWithLiveAgent: ReadonlySet<string>,
  worktreeIdsWithStructuredChat: ReadonlySet<string> = EMPTY_WORKTREE_IDS
): boolean {
  return !hasActiveWorkspaceActivity(
    worktreeId,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat
  )
}
