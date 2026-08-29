import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { resolveAgentStatusWorktreeId } from './agent-status-worktree-attribution'

type TerminalLikeTab = Pick<TerminalTab, 'id'>
type BrowserLikeTab = { id: string }

const EMPTY_WORKTREE_ID_SET: ReadonlySet<string> = new Set()

type TabsByWorktree = Record<string, readonly TerminalLikeTab[]>
type PtyIdsByTabId = Record<string, string[]>
type BrowserTabsByWorktree = Record<string, readonly BrowserLikeTab[]>
export type LiveAgentWorktreeStatus = 'working' | 'monitoring' | 'permission'

/**
 * Worktree ids that currently have a live agent session, derived from the
 * live `agentStatusByPaneKey` map.
 *
 * Why only fresh in-progress rows: disconnected SSH and completed headless
 * agents can retain status entries without an open session.
 */
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
      const status =
        entry.state === 'working'
          ? entry.workingMode === 'monitoring'
            ? 'monitoring'
            : 'working'
          : 'permission'
      const current = result.get(worktreeId)
      if (
        status === 'permission' ||
        current === undefined ||
        (status === 'working' && current === 'monitoring')
      ) {
        result.set(worktreeId, status)
      }
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
  pendingReconnectWorktreeIds: ReadonlySet<string> = EMPTY_WORKTREE_ID_SET
): boolean {
  const tabs = tabsByWorktree?.[worktreeId] ?? []
  const hasLiveTerminal =
    ptyIdsByTabId != null && tabs.some((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))
  const hasBrowser = (browserTabsByWorktree?.[worktreeId] ?? []).length > 0
  // Why: a running agent keeps the workspace visible through brief PTY gaps
  // such as an SSH reconnect or an unmounted remote pane. #7197
  const hasLiveAgent = worktreeIdsWithLiveAgent.has(worktreeId)
  // Startup hydrates tabs before reconnect restores their ptyIds; without this a
  // workspace awake at shutdown reads as asleep until then. #16247
  const isReattaching = pendingReconnectWorktreeIds.has(worktreeId)
  return hasLiveTerminal || hasBrowser || hasLiveAgent || isReattaching
}

export function isInactiveWorkspace(
  worktreeId: string,
  tabsByWorktree: TabsByWorktree | null | undefined,
  ptyIdsByTabId: PtyIdsByTabId | null | undefined,
  browserTabsByWorktree: BrowserTabsByWorktree | null | undefined,
  worktreeIdsWithLiveAgent: ReadonlySet<string>,
  pendingReconnectWorktreeIds: ReadonlySet<string> = EMPTY_WORKTREE_ID_SET
): boolean {
  return !hasActiveWorkspaceActivity(
    worktreeId,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    pendingReconnectWorktreeIds
  )
}
