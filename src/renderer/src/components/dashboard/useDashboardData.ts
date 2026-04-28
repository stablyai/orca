import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType
} from '../../../../shared/agent-status-types'
import type { Repo, Worktree, TerminalTab } from '../../../../shared/types'

// ─── Dashboard data types ─────────────────────────────────────────────────────

export type DashboardAgentRow = {
  paneKey: string
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  state: AgentStatusState | 'idle'
  /** When this agent first began reporting status. Derived from the oldest
   *  stateHistory entry, falling back to updatedAt when no history exists yet.
   *  Used to sort agents by when they started. */
  startedAt: number
}

export type DashboardWorktreeCard = {
  repo: Repo
  worktree: Worktree
  agents: DashboardAgentRow[]
  /** Highest-priority agent state for filtering.
   *  Priority: blocked > working > done > idle.
   *  `waiting` is folded into `blocked` — both are attention-needed states. */
  dominantState: 'working' | 'blocked' | 'done' | 'idle'
  /** Earliest startedAt across all agents in this worktree. Once the worktree
   *  has at least one agent, this value is stable — new agents starting in
   *  the same worktree do not change it. Sorting worktrees by this value
   *  asc keeps list order stable while the user is reading. */
  earliestStartedAt: number
}

export type DashboardRepoGroup = {
  repo: Repo
  worktrees: DashboardWorktreeCard[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function computeDominantState(
  agents: DashboardAgentRow[]
): DashboardWorktreeCard['dominantState'] {
  if (agents.length === 0) {
    return 'idle'
  }
  let hasWorking = false
  let hasDone = false
  for (const agent of agents) {
    if (agent.state === 'blocked' || agent.state === 'waiting') {
      return 'blocked'
    }
    if (agent.state === 'working') {
      hasWorking = true
    }
    if (agent.state === 'done') {
      hasDone = true
    }
  }
  if (hasWorking) {
    return 'working'
  }
  if (hasDone) {
    return 'done'
  }
  return 'idle'
}

// Why: the dashboard only surfaces agents that have reported state via a hook.
// A tab hosting a shell, a REPL before its first turn, or an agent we have no
// hook integration for will have no entry here — and that's correct. The
// dashboard's job is to show *agent work in progress*, not to guess which
// terminals might contain an agent.
function buildAgentRowsForWorktree(
  worktreeId: string,
  tabsByWorktree: Record<string, TerminalTab[]>,
  entriesByTabId: Map<string, AgentStatusEntry[]>,
  now: number
): DashboardAgentRow[] {
  const tabs = tabsByWorktree[worktreeId] ?? []
  const rows: DashboardAgentRow[] = []

  for (const tab of tabs) {
    const explicitEntries = entriesByTabId.get(tab.id) ?? []
    for (const entry of explicitEntries) {
      // Why: decay stale working/blocked/waiting entries to 'idle' when the hook
      // stream has gone silent past AGENT_STATUS_STALE_AFTER_MS (30 min TTL).
      // Without this, an agent process that exited without sending a final
      // update would remain "working" forever — the Active/Blocked filters and
      // the sidebar's running-agents count would mislead the user into chasing
      // dead work. `done` is terminal and must NOT decay to idle: retention
      // (collectRetainedAgentsOnDisappear) only retains rows whose prev state
      // was 'done', so decaying a stale done → idle would silently drop the
      // completion signal when the entry later disappears.
      const isFresh = isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
      const shouldDecay =
        !isFresh &&
        (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
      rows.push({
        paneKey: entry.paneKey,
        entry,
        tab,
        agentType: entry.agentType ?? 'unknown',
        state: shouldDecay ? 'idle' : entry.state,
        // Why: the oldest stateHistory entry's startedAt is the agent's original
        // "first seen" timestamp. When history is empty the entry has never
        // transitioned state, so stateStartedAt (the moment the current — and
        // only — state began) is the true first-seen timestamp. Do NOT fall back
        // to updatedAt: it advances on every tool/prompt ping within the same
        // state, which would corrupt oldest-first ordering and the "started …
        // ago" display for long-running agents between state transitions. See
        // agent-status.ts (stateStartedAt carry-forward on same-state pings).
        startedAt: entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
      })
    }
  }

  return rows
}

function buildDashboardData(
  repos: Repo[],
  worktreesByRepo: Record<string, Worktree[]>,
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  now: number
): DashboardRepoGroup[] {
  // Why: build a tabId -> entries index once per dashboard computation instead
  // of re-scanning every agent status entry inside the per-tab loop. paneKey
  // is formatted as `${tabId}:${paneId}`; splitting on the first ':' lets us
  // bucket entries by tab in a single O(N) pass, turning the per-worktree
  // build from O(tabs × statuses) into O(tabs).
  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const colonIndex = paneKey.indexOf(':')
    if (colonIndex === -1) {
      continue
    }
    const tabId = paneKey.slice(0, colonIndex)
    const bucket = entriesByTabId.get(tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      entriesByTabId.set(tabId, [entry])
    }
  }

  return repos.map((repo) => {
    const worktrees = (worktreesByRepo[repo.id] ?? [])
      .filter((w) => !w.isArchived)
      .map((worktree) => {
        const agents = buildAgentRowsForWorktree(worktree.id, tabsByWorktree, entriesByTabId, now)
        // Why: sort agents within a worktree oldest-first by startedAt. A new
        // agent appears at the BOTTOM so it doesn't shove the row the user
        // is currently reading down the list. Stable order also means
        // retained/live transitions don't reshuffle siblings. Users care
        // less about "which is newest" than "let this list stop moving
        // while I read it".
        agents.sort((a, b) => a.startedAt - b.startedAt)
        // Why: earliestStartedAt (oldest agent in the worktree) is stable once
        // the worktree has any agent at all. Using it for outer sorts means
        // a brand-new agent in a different worktree no longer shoves this
        // card around while the user is reading.
        const earliestStartedAt = agents.length > 0 ? agents[0].startedAt : 0
        return {
          repo,
          worktree,
          agents,
          dominantState: computeDominantState(agents),
          earliestStartedAt
        } satisfies DashboardWorktreeCard
      })

    return { repo, worktrees } satisfies DashboardRepoGroup
  })
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDashboardData(): DashboardRepoGroup[] {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries expire,
  // even if no new PTY data arrives.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const dashboardEnabled = useAppStore((s) => s.settings?.experimentalAgentDashboard === true)

  return useMemo(
    // Why: Date.now() is read inside the memo (not as a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks. The epoch bumps when the
    // freshness boundary crosses, driving re-evaluation without coupling to
    // wall-clock time directly.
    () => {
      // Why: experimental-setting gate inside the memo avoids the
      // O(repos × worktrees × agents) rebuild on every store update when the
      // dashboard is disabled. Store selectors still subscribe to keep
      // rules-of-hooks satisfied and so flipping the setting re-renders
      // consumers.
      if (!dashboardEnabled) {
        return []
      }
      return buildDashboardData(
        repos,
        worktreesByRepo,
        tabsByWorktree,
        agentStatusByPaneKey,
        Date.now()
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      repos,
      worktreesByRepo,
      tabsByWorktree,
      agentStatusByPaneKey,
      agentStatusEpoch,
      dashboardEnabled
    ]
  )
}
