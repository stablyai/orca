import { useState, useMemo } from 'react'
import type {
  DashboardRepoGroup,
  DashboardWorktreeCard,
  DashboardAgentRow
} from './useDashboardData'

export type DashboardFilter = 'active' | 'all' | 'blocked' | 'done'

export type FilteredDashboardGroup = {
  repo: DashboardRepoGroup['repo']
  worktrees: DashboardWorktreeCard[]
  /** Earliest startedAt across all worktrees in this group. Stable once the
   *  group has any agent — used for deterministic ordering between groups. */
  earliestStartedAt: number
  /**
   * Why: per-repo agent state counts are computed here (inside the filter
   * memo) rather than inline in the render body of AgentDashboard. Inline
   * iteration re-walked every agent in every worktree on each `now` tick,
   * search change, or store update; precomputing keeps that O(N) scan scoped
   * to actual changes in `groups`/`filter`/`searchQuery`. Counts reflect the
   * *filtered* agents the user actually sees, which matches the header
   * numbers to the rendered rows.
   */
  running: number
  blocked: number
  done: number
}

// Why: filters apply to individual AGENTS, not worktrees. Previously we filtered
// by the worktree's dominantState, so a done agent stayed visible under the
// 'active' tab if a sibling agent in the same worktree was working — which
// defeats the point of the filter. Agent-level filtering keeps the worktree
// grouping intact but hides rows whose state doesn't match.
function matchesAgent(agent: DashboardAgentRow, filter: DashboardFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return agent.state === 'working'
    case 'blocked':
      return agent.state === 'blocked' || agent.state === 'waiting'
    case 'done':
      return agent.state === 'done'
  }
}

// Why: search also matches per-agent — so a typo'd prompt in one agent doesn't
// drag its unrelated siblings into the visible set. Repo/worktree/branch hits
// still surface the whole worktree row (keep all its agents) because at that
// point the user is looking for the *worktree*, not a specific agent inside it.
function worktreeMetaMatches(card: DashboardWorktreeCard, q: string): boolean {
  if (card.repo.displayName.toLowerCase().includes(q)) {
    return true
  }
  if (card.worktree.displayName.toLowerCase().includes(q)) {
    return true
  }
  const branch = card.worktree.branch?.toLowerCase() ?? ''
  return branch.includes(q)
}

function agentMatchesSearch(agent: DashboardAgentRow, q: string): boolean {
  if (agent.entry.prompt?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.toolName?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.toolInput?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.lastAssistantMessage?.toLowerCase().includes(q)) {
    return true
  }
  return agent.agentType.toLowerCase().includes(q)
}

export function useDashboardFilter(
  groups: DashboardRepoGroup[],
  searchQuery: string
): {
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
  filteredGroups: FilteredDashboardGroup[]
  hasResults: boolean
} {
  const [filter, setFilter] = useState<DashboardFilter>('all')

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const out: FilteredDashboardGroup[] = []
    for (const group of groups) {
      const worktrees: DashboardWorktreeCard[] = []
      // Why: accumulate per-repo state counts while we already iterate the
      // filtered agents — avoids a second pass (and avoids re-walking every
      // agent in the AgentDashboard render body on every `now` tick).
      let running = 0
      let blocked = 0
      let done = 0
      for (const wt of group.worktrees) {
        const stateMatched = wt.agents.filter((a) => matchesAgent(a, filter))
        if (stateMatched.length === 0) {
          continue
        }
        const agents: DashboardAgentRow[] =
          q.length === 0 || worktreeMetaMatches(wt, q)
            ? stateMatched
            : stateMatched.filter((a) => agentMatchesSearch(a, q))
        // Why: drop worktrees whose agents are all filtered out — an empty
        // row would just be noise in the list.
        if (agents.length === 0) {
          continue
        }
        for (const agent of agents) {
          if (agent.state === 'working') {
            running++
          } else if (agent.state === 'blocked' || agent.state === 'waiting') {
            blocked++
          } else if (agent.state === 'done') {
            done++
          }
        }
        // Why: recompute earliestStartedAt from the filtered agents so the
        // sort key below reflects the agents this worktree actually displays.
        // Otherwise a filter that removes the earliest-starting agent leaves
        // a phantom sort key from useDashboardData's un-filtered list and
        // worktrees drift out of order when filters/search are applied.
        // agents.length > 0 is guaranteed by the early-continue above, and
        // agents are pre-sorted asc by startedAt upstream, so agents[0] is
        // the minimum. startedAt is always set (useDashboardData derives it
        // from stateStartedAt, which is set on every entry), so no fallback
        // to wt.earliestStartedAt is needed — and using that upstream value
        // would reintroduce the exact phantom sort key this block avoids.
        const filteredEarliest = agents[0].startedAt
        // Why: preserve worktree card identity in the no-op case so
        // React.memo on DashboardWorktreeCard can short-circuit. `filter`
        // always allocates a new array even when no elements are removed, so
        // reference equality against `wt.agents` is never true — length
        // equality is our proxy for "nothing was filtered out" (safe because
        // .filter preserves order, so equal length means every element
        // passed). When agents are full AND earliestStartedAt is unchanged,
        // the upstream `wt` object is already the correct card and spreading
        // would only defeat memoization, causing every `now` tick or
        // unrelated store update to re-render all cards.
        const stateMatchedAll = stateMatched.length === wt.agents.length
        const agentsAreFull = stateMatchedAll && agents.length === wt.agents.length
        const passthrough = agentsAreFull && filteredEarliest === wt.earliestStartedAt
        worktrees.push(passthrough ? wt : { ...wt, agents, earliestStartedAt: filteredEarliest })
      }
      if (worktrees.length === 0) {
        continue
      }
      // Why: sort worktrees within a group by earliest-started agent asc.
      // Stable once populated — a new agent starting in a sibling worktree
      // doesn't reshuffle this one while the user reads.
      worktrees.sort((a, b) => a.earliestStartedAt - b.earliestStartedAt)
      out.push({
        repo: group.repo,
        worktrees,
        earliestStartedAt: worktrees[0]?.earliestStartedAt ?? 0,
        running,
        blocked,
        done
      })
    }
    // Why: sort groups by the earliest-started worktree asc for the same
    // "stop moving while I read" reason. Repos with no activity yet get 0
    // and fall to the top, which is fine since they render empty anyway.
    out.sort((a, b) => a.earliestStartedAt - b.earliestStartedAt)
    return out
  }, [groups, filter, searchQuery])

  // Why: filteredGroups drops any group whose worktrees array is empty (see the
  // early-continue above), so a non-empty groups array guarantees at least one
  // visible worktree. Avoids an extra flatMap just to check length.
  const hasResults = filteredGroups.length > 0

  return {
    filter,
    setFilter,
    filteredGroups,
    hasResults
  }
}
