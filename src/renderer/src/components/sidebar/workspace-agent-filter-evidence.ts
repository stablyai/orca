import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  collectWorkspaceAgentIds,
  workspaceMatchesAgentFilter,
  type FilterAgentIds
} from '../../../../shared/workspace-agent-filter'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { resolveAgentTypeFromTerminalTitle } from './worktree-title-derived-agent-rows'

/**
 * Why: workspace cards already derive agent identity from created-with,
 * launchAgent, live/retained hook rows, sleeping sessions, and title fallback.
 * The filter must read those same records instead of persisting a parallel field.
 */
type AgentFilterTabEvidence = {
  id?: string
  launchAgent?: TerminalTab['launchAgent']
  title?: string | null
}

export function collectWorktreeAgentIds(args: {
  createdWithAgent?: string | null
  tabs?: readonly AgentFilterTabEvidence[] | null
  extraAgentTypes?: readonly (string | null | undefined)[] | null
}): Set<TuiAgent> {
  const agents: (string | null | undefined)[] = [args.createdWithAgent]
  for (const tab of args.tabs ?? []) {
    agents.push(tab.launchAgent, resolveAgentTypeFromTerminalTitle(tab.title))
  }
  if (args.extraAgentTypes) {
    agents.push(...args.extraAgentTypes)
  }
  return collectWorkspaceAgentIds(agents)
}

export function worktreeMatchesAgentFilter(
  worktree: { id: string; createdWithAgent?: string | null },
  selectedAgentIds: FilterAgentIds,
  lookup: {
    tabsByWorktree?: Record<string, readonly AgentFilterTabEvidence[]> | null
    agentTypesByWorktree?: Record<string, readonly (string | null | undefined)[]> | null
  }
): boolean {
  return workspaceMatchesAgentFilter(
    collectWorktreeAgentIds({
      createdWithAgent: worktree.createdWithAgent,
      tabs: lookup.tabsByWorktree?.[worktree.id],
      extraAgentTypes: lookup.agentTypesByWorktree?.[worktree.id]
    }),
    selectedAgentIds
  )
}

export function collectAgentTypesByWorktree(args: {
  agentStatusByPaneKey?: Record<
    string,
    Pick<AgentStatusEntry, 'worktreeId' | 'agentType' | 'paneKey'>
  > | null
  retainedAgentsByPaneKey?: Record<
    string,
    Pick<RetainedAgentEntry, 'worktreeId' | 'agentType'>
  > | null
  sleepingAgentSessionsByPaneKey?: Record<
    string,
    Pick<SleepingAgentSessionRecord, 'worktreeId' | 'agent'>
  > | null
  tabsByWorktree?: Record<string, readonly Pick<TerminalTab, 'id'>[]> | null
}): Record<string, string[]> {
  const tabWorktreeByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(args.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      tabWorktreeByTabId.set(tab.id, worktreeId)
    }
  }

  const out: Record<string, string[]> = {}
  const add = (worktreeId: string | undefined, agentType: string | undefined): void => {
    if (!worktreeId || !agentType) {
      return
    }
    const bucket = out[worktreeId]
    if (bucket) {
      bucket.push(agentType)
    } else {
      out[worktreeId] = [agentType]
    }
  }

  for (const entry of Object.values(args.agentStatusByPaneKey ?? {})) {
    let worktreeId = entry.worktreeId
    if (!worktreeId) {
      const parsed = parsePaneKey(entry.paneKey)
      worktreeId = parsed ? tabWorktreeByTabId.get(parsed.tabId) : undefined
    }
    add(worktreeId, entry.agentType)
  }

  for (const retained of Object.values(args.retainedAgentsByPaneKey ?? {})) {
    add(retained.worktreeId, retained.agentType)
  }

  for (const sleeping of Object.values(args.sleepingAgentSessionsByPaneKey ?? {})) {
    add(sleeping.worktreeId, sleeping.agent)
  }

  return out
}

export function filterWorktreesBySelectedAgents<
  T extends { id: string; createdWithAgent?: string | null }
>(
  worktrees: readonly T[],
  selectedAgentIds: FilterAgentIds,
  lookup: {
    tabsByWorktree?: Record<string, readonly AgentFilterTabEvidence[]> | null
    agentTypesByWorktree?: Record<string, readonly (string | null | undefined)[]> | null
  }
): T[] {
  if (!selectedAgentIds) {
    return worktrees as T[]
  }
  return worktrees.filter((worktree) =>
    worktreeMatchesAgentFilter(worktree, selectedAgentIds, lookup)
  )
}

export function collectScopedAgentTypesByWorktree(args: {
  filterAgentIds: FilterAgentIds
  agentStatusByPaneKey?: Parameters<typeof collectAgentTypesByWorktree>[0]['agentStatusByPaneKey']
  retainedAgentsByPaneKey?: Parameters<
    typeof collectAgentTypesByWorktree
  >[0]['retainedAgentsByPaneKey']
  sleepingAgentSessionsByPaneKey?: Parameters<
    typeof collectAgentTypesByWorktree
  >[0]['sleepingAgentSessionsByPaneKey']
  tabsByWorktree?: Parameters<typeof collectAgentTypesByWorktree>[0]['tabsByWorktree']
}): Record<string, string[]> | null {
  if (!args.filterAgentIds) {
    return null
  }
  return collectAgentTypesByWorktree(args)
}
