import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  collectWorkspaceAgentIds,
  nextFilterAgentIdsForReveal,
  workspaceMatchesAgentFilter,
  type FilterAgentIds
} from '../../../../shared/workspace-agent-filter'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { resolveAgentTypeFromTerminalTitle } from './worktree-title-derived-agent-rows'
import {
  paneTitlesAndLaunchOwnerForAgentFilter,
  type AgentFilterLayoutsByTabId,
  type AgentFilterTabEvidence
} from './workspace-agent-filter-pane-ownership'

/**
 * Why: workspace cards already derive agent identity from created-with,
 * launchAgent, live/retained hook rows, sleeping sessions, and title fallback.
 * The filter must read those same records instead of persisting a parallel field.
 */
type AgentFilterWorktree = Pick<Worktree, 'id' | 'hostId'>

type AgentFilterLookup = {
  tabsByWorktree?: Record<string, readonly AgentFilterTabEvidence[]> | null
  agentTypesByWorktree?: Record<string, readonly (string | null | undefined)[]> | null
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>> | null
  terminalLayoutsByTabId?: AgentFilterLayoutsByTabId
  collidingWorktreeIds?: ReadonlySet<string>
}

export function collectWorktreeAgentIds(args: {
  createdWithAgent?: string | null
  tabs?: readonly AgentFilterTabEvidence[] | null
  extraAgentTypes?: readonly (string | null | undefined)[] | null
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>> | null
  terminalLayoutsByTabId?: AgentFilterLayoutsByTabId
}): Set<TuiAgent> {
  const agents: (string | null | undefined)[] = [args.createdWithAgent]
  for (const tab of args.tabs ?? []) {
    const { titles, owner } = paneTitlesAndLaunchOwnerForAgentFilter(
      tab,
      args.runtimePaneTitlesByTabId,
      args.terminalLayoutsByTabId
    )
    const ownerOpts = owner ? { ownerIsLaunch: true } : undefined
    agents.push(tab.launchAgent, resolveAgentTypeFromTerminalTitle(tab.title, owner, ownerOpts))
    for (const paneTitle of titles) {
      agents.push(resolveAgentTypeFromTerminalTitle(paneTitle, owner, ownerOpts))
    }
  }
  if (args.extraAgentTypes) {
    agents.push(...args.extraAgentTypes)
  }
  return collectWorkspaceAgentIds(agents)
}

export function collidingWorktreeIds(worktrees: readonly AgentFilterWorktree[]): Set<string> {
  const hosts = new Map<string, Set<string>>()
  for (const worktree of worktrees) {
    const host = worktree.hostId ?? ''
    const bucket = hosts.get(worktree.id)
    if (bucket) {
      bucket.add(host)
    } else {
      hosts.set(worktree.id, new Set([host]))
    }
  }
  const colliding = new Set<string>()
  for (const [id, hostSet] of hosts) {
    if (hostSet.size > 1) {
      colliding.add(id)
    }
  }
  return colliding
}

export function collectWorktreeFilterAgentIds(
  worktree: { id: string; createdWithAgent?: string | null; hostId?: Worktree['hostId'] },
  lookup: AgentFilterLookup
): Set<TuiAgent> {
  const colliding = lookup.collidingWorktreeIds?.has(worktree.id) ?? false
  const extraKey = colliding && worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
  return collectWorktreeAgentIds({
    createdWithAgent: worktree.createdWithAgent,
    tabs: colliding ? undefined : lookup.tabsByWorktree?.[worktree.id],
    extraAgentTypes: lookup.agentTypesByWorktree?.[extraKey],
    runtimePaneTitlesByTabId: colliding ? undefined : lookup.runtimePaneTitlesByTabId,
    terminalLayoutsByTabId: colliding ? undefined : lookup.terminalLayoutsByTabId
  })
}

/**
 * Confirming reveal must change the Agent filter when the sidebar still hides
 * the workspace. If adding its agents is a no-op or still would not match, All.
 */
export function resolveRevealFilterAgentIds(
  current: FilterAgentIds,
  worktree: { id: string; createdWithAgent?: string | null; hostId?: Worktree['hostId'] },
  lookup: AgentFilterLookup,
  hiddenBySidebarFilters: boolean
): FilterAgentIds {
  if (!current || !hiddenBySidebarFilters) {
    return current
  }
  const next = nextFilterAgentIdsForReveal(current, collectWorktreeFilterAgentIds(worktree, lookup))
  if (next === current || !worktreeMatchesAgentFilter(worktree, next, lookup)) {
    return null
  }
  return next
}

export function worktreeMatchesAgentFilter(
  worktree: { id: string; createdWithAgent?: string | null; hostId?: Worktree['hostId'] },
  selectedAgentIds: FilterAgentIds,
  lookup: AgentFilterLookup
): boolean {
  return workspaceMatchesAgentFilter(
    collectWorktreeFilterAgentIds(worktree, lookup),
    selectedAgentIds
  )
}

function hostIdMatchingConnection(
  worktrees: readonly AgentFilterWorktree[],
  worktreeId: string,
  connectionId: string | null | undefined
): ExecutionHostId | undefined {
  const candidates = worktrees.filter((worktree) => worktree.id === worktreeId)
  if (candidates.length === 1) {
    return candidates[0]?.hostId
  }
  const local = connectionId == null || connectionId === ''
  for (const worktree of candidates) {
    const host = parseExecutionHostId(worktree.hostId)
    if (local) {
      if (!host || host.kind === 'local') {
        return worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
      }
      continue
    }
    if (host?.kind === 'ssh' && host.targetId === connectionId) {
      return worktree.hostId
    }
    if (host?.kind === 'runtime' && host.environmentId === connectionId) {
      return worktree.hostId
    }
  }
  return undefined
}

export function collectAgentTypesByWorktree(args: {
  agentStatusByPaneKey?: Record<
    string,
    Pick<AgentStatusEntry, 'worktreeId' | 'agentType' | 'paneKey' | 'connectionId'>
  > | null
  retainedAgentsByPaneKey?: Record<
    string,
    Pick<RetainedAgentEntry, 'worktreeId' | 'agentType'> & {
      entry?: Pick<AgentStatusEntry, 'connectionId'>
    }
  > | null
  sleepingAgentSessionsByPaneKey?: Record<
    string,
    Pick<SleepingAgentSessionRecord, 'worktreeId' | 'agent' | 'connectionId'>
  > | null
  tabsByWorktree?: Record<string, readonly Pick<TerminalTab, 'id'>[]> | null
  worktrees?: readonly AgentFilterWorktree[] | null
}): Record<string, string[]> {
  const worktrees = args.worktrees ?? []
  const colliding = collidingWorktreeIds(worktrees)
  const tabWorktreeByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(args.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      tabWorktreeByTabId.set(tab.id, worktreeId)
    }
  }

  const out: Record<string, string[]> = {}
  const add = (
    worktreeId: string | undefined,
    agentType: string | undefined,
    connectionId?: string | null
  ): void => {
    if (!worktreeId || !agentType) {
      return
    }
    let key = worktreeId
    if (colliding.has(worktreeId)) {
      const hostId = hostIdMatchingConnection(worktrees, worktreeId, connectionId)
      if (!hostId) {
        return
      }
      key = composeWorktreeHostIdentity(hostId, worktreeId)
    }
    const bucket = out[key]
    if (bucket) {
      bucket.push(agentType)
    } else {
      out[key] = [agentType]
    }
  }

  for (const entry of Object.values(args.agentStatusByPaneKey ?? {})) {
    let worktreeId = entry.worktreeId
    if (!worktreeId) {
      const parsed = parsePaneKey(entry.paneKey)
      worktreeId = parsed ? tabWorktreeByTabId.get(parsed.tabId) : undefined
    }
    add(worktreeId, entry.agentType, entry.connectionId)
  }

  for (const retained of Object.values(args.retainedAgentsByPaneKey ?? {})) {
    add(retained.worktreeId, retained.agentType, retained.entry?.connectionId)
  }

  for (const sleeping of Object.values(args.sleepingAgentSessionsByPaneKey ?? {})) {
    add(sleeping.worktreeId, sleeping.agent, sleeping.connectionId)
  }

  return out
}

export function filterWorktreesBySelectedAgents<
  T extends { id: string; createdWithAgent?: string | null; hostId?: Worktree['hostId'] }
>(
  worktrees: readonly T[],
  selectedAgentIds: FilterAgentIds,
  lookup: Omit<AgentFilterLookup, 'collidingWorktreeIds'>
): T[] {
  if (!selectedAgentIds) {
    return [...worktrees]
  }
  const colliding = collidingWorktreeIds(worktrees)
  return worktrees.filter((worktree) =>
    worktreeMatchesAgentFilter(worktree, selectedAgentIds, {
      ...lookup,
      collidingWorktreeIds: colliding
    })
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
  worktrees?: Parameters<typeof collectAgentTypesByWorktree>[0]['worktrees']
}): Record<string, string[]> | null {
  if (!args.filterAgentIds) {
    return null
  }
  return collectAgentTypesByWorktree(args)
}
