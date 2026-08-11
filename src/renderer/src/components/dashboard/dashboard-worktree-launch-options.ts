import type { AppState } from '@/store/types'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  DASHBOARD_MAX_LAUNCH_WORKTREES,
  type DashboardCard,
  type DashboardWorkspace
} from '../../../../shared/dashboard-snapshot'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  filterEnabledTuiAgents,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveDashboardFolderCatalogOwner } from './dashboard-folder-catalog-owner'

export type DashboardLaunchDetectionState = Pick<
  AppState,
  | 'detectedAgentIds'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'remoteDetectedAgentIds'
  | 'runtimeDetectedAgentIds'
>

type DashboardLaunchOptionState = Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo'> &
  Partial<DashboardLaunchDetectionState>

type DashboardLaunchCatalog = {
  folderIdCounts: Map<string, number>
  reposById: Map<string, AppState['repos'][number]>
  worktreesByRepoAndId: Map<string, Map<string, AppState['worktreesByRepo'][string][number]>>
}

type DashboardAgentDetection = {
  agents: readonly TuiAgent[]
  ownerResolved: boolean
}

function buildDashboardLaunchCatalog(state: DashboardLaunchOptionState): DashboardLaunchCatalog {
  const folderIdCounts = new Map<string, number>()
  for (const folder of state.folderWorkspaces ?? []) {
    folderIdCounts.set(folder.id, (folderIdCounts.get(folder.id) ?? 0) + 1)
  }
  return {
    folderIdCounts,
    reposById: new Map((state.repos ?? []).map((repo) => [repo.id, repo])),
    worktreesByRepoAndId: new Map(
      Object.entries(state.worktreesByRepo ?? {}).map(([repoId, worktrees]) => [
        repoId,
        new Map(worktrees.map((worktree) => [worktree.id, worktree]))
      ])
    )
  }
}

function detectedAgentsForWorktree(
  state: DashboardLaunchOptionState,
  worktreeId: string,
  repoId: string,
  catalog: DashboardLaunchCatalog,
  executionHostId?: DashboardWorkspace['executionHostId'],
  repoOwner?: AppState['repos'][number]
): DashboardAgentDetection {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const matchingFolderCount = catalog.folderIdCounts.get(workspaceScope.folderWorkspaceId) ?? 0
    const owner = resolveDashboardFolderCatalogOwner(
      {
        folderWorkspaces: state.folderWorkspaces ?? [],
        projectGroups: state.projectGroups ?? []
      },
      workspaceScope.folderWorkspaceId
    )
    if (
      matchingFolderCount !== 1 ||
      !owner ||
      (executionHostId && owner.executionHostId !== executionHostId)
    ) {
      return { agents: [], ownerResolved: false }
    }
    const host = parseExecutionHostId(owner?.executionHostId)
    if (host?.kind === 'runtime') {
      return {
        agents: state.runtimeDetectedAgentIds?.[host.environmentId] ?? [],
        ownerResolved: true
      }
    }
    if (host?.kind === 'ssh') {
      return {
        agents: state.remoteDetectedAgentIds?.[host.targetId] ?? [],
        ownerResolved: true
      }
    }
    return {
      agents: host?.kind === 'local' ? (state.detectedAgentIds ?? []) : [],
      ownerResolved: host?.kind === 'local'
    }
  }

  const catalogRepoId = repoOwner?.id ?? repoId
  const worktree = catalog.worktreesByRepoAndId.get(catalogRepoId)?.get(worktreeId)
  const repo = repoOwner ?? catalog.reposById.get(worktree?.repoId ?? catalogRepoId)
  const runtimeOwnerEnvironmentId = worktree?.runtimeOwnerEnvironmentId?.trim()
  const host = parseExecutionHostId(
    runtimeOwnerEnvironmentId
      ? toRuntimeExecutionHostId(runtimeOwnerEnvironmentId)
      : (worktree?.hostId ?? repo?.executionHostId)
  )
  if (host?.kind === 'runtime') {
    return {
      agents: state.runtimeDetectedAgentIds?.[host.environmentId] ?? [],
      ownerResolved: true
    }
  }
  const connectionId = host?.kind === 'ssh' ? host.targetId : repo?.connectionId
  return {
    agents: connectionId
      ? (state.remoteDetectedAgentIds?.[connectionId] ?? [])
      : (state.detectedAgentIds ?? []),
    ownerResolved: true
  }
}

/** Host-detected choices plus providers already proven to run in the workspace. */
export function buildDashboardWorktreeLaunchOptions(
  state: DashboardLaunchOptionState,
  cards: readonly DashboardCard[],
  workspaces: readonly DashboardWorkspace[] = [],
  repoOwnersByWorktreeId: ReadonlyMap<string, AppState['repos'][number]> = new Map()
): Record<string, TuiAgent[]> {
  const catalog = buildDashboardLaunchCatalog(state)
  const cardsByWorktreeId = new Map<string, DashboardCard[]>()
  const executionHostIdByWorktreeId = new Map<string, DashboardWorkspace['executionHostId']>()
  const ambiguousOwnerWorktreeIds = new Set<string>()
  const repoIdByWorktreeId = new Map(
    workspaces.map((workspace) => [workspace.worktreeId, workspace.repoId])
  )
  const recordExecutionHostId = (
    worktreeId: string,
    executionHostId: DashboardWorkspace['executionHostId'] | undefined
  ): void => {
    if (!executionHostId) {
      return
    }
    const existing = executionHostIdByWorktreeId.get(worktreeId)
    if (existing && existing !== executionHostId) {
      ambiguousOwnerWorktreeIds.add(worktreeId)
    } else {
      executionHostIdByWorktreeId.set(worktreeId, executionHostId)
    }
  }
  for (const workspace of workspaces) {
    recordExecutionHostId(workspace.worktreeId, workspace.executionHostId)
  }
  for (const card of cards) {
    repoIdByWorktreeId.set(card.worktreeId, card.repoId)
    const existing = cardsByWorktreeId.get(card.worktreeId)
    if (existing) {
      existing.push(card)
    } else {
      cardsByWorktreeId.set(card.worktreeId, [card])
    }
    recordExecutionHostId(card.worktreeId, card.executionHostId)
  }

  const result: Record<string, TuiAgent[]> = {}
  for (const [worktreeId, repoId] of repoIdByWorktreeId) {
    // Past the validator's bound the snapshot itself would be rejected, so the
    // launcher goes quiet for the tail rather than taking the board down.
    if (Object.keys(result).length >= DASHBOARD_MAX_LAUNCH_WORKTREES) {
      break
    }
    const worktreeCards = cardsByWorktreeId.get(worktreeId) ?? []
    const detection = detectedAgentsForWorktree(
      state,
      worktreeId,
      repoId,
      catalog,
      executionHostIdByWorktreeId.get(worktreeId),
      repoOwnersByWorktreeId.get(worktreeId)
    )
    if (ambiguousOwnerWorktreeIds.has(worktreeId) || !detection.ownerResolved) {
      result[worktreeId] = []
      continue
    }
    const available = new Set<TuiAgent>(detection.agents)
    for (const card of worktreeCards) {
      if (isTuiAgent(card.agentType)) {
        available.add(card.agentType)
      }
    }
    const enabled = filterEnabledTuiAgents(
      TUI_AGENT_AUTO_PICK_ORDER.filter((agent) => available.has(agent)),
      state.settings?.disabledTuiAgents
    )
    const preferred = state.settings?.defaultTuiAgent
    result[worktreeId] =
      preferred && preferred !== 'blank' && enabled.includes(preferred)
        ? [preferred, ...enabled.filter((agent) => agent !== preferred)]
        : enabled
  }
  return result
}
