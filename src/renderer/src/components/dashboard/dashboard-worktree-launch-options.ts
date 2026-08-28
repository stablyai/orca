import type { AppState } from '@/store/types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
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
import type { TuiAgent } from '../../../../shared/tui-agent'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

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
  foldersById: Map<string, AppState['folderWorkspaces'][number]>
  groupsById: Map<string, AppState['projectGroups'][number]>
  reposById: Map<string, AppState['repos'][number]>
  worktreesByRepoAndId: Map<string, Map<string, AppState['worktreesByRepo'][string][number]>>
}

function buildDashboardLaunchCatalog(state: DashboardLaunchOptionState): DashboardLaunchCatalog {
  return {
    foldersById: new Map((state.folderWorkspaces ?? []).map((folder) => [folder.id, folder])),
    groupsById: new Map((state.projectGroups ?? []).map((group) => [group.id, group])),
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
  catalog: DashboardLaunchCatalog
): readonly TuiAgent[] {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folder = catalog.foldersById.get(workspaceScope.folderWorkspaceId)
    const group = folder ? catalog.groupsById.get(folder.projectGroupId) : undefined
    const host = parseExecutionHostId(group?.executionHostId)
    if (host?.kind === 'runtime') {
      return state.runtimeDetectedAgentIds?.[host.environmentId] ?? []
    }
    const connectionId = folder?.connectionId ?? group?.connectionId
    return connectionId ? (state.remoteDetectedAgentIds?.[connectionId] ?? []) : []
  }

  const worktree = catalog.worktreesByRepoAndId.get(repoId)?.get(worktreeId)
  const repo = catalog.reposById.get(worktree?.repoId ?? repoId)
  const host = parseExecutionHostId(worktree?.hostId ?? repo?.executionHostId)
  if (host?.kind === 'runtime') {
    return state.runtimeDetectedAgentIds?.[host.environmentId] ?? []
  }
  const connectionId = host?.kind === 'ssh' ? host.targetId : repo?.connectionId
  return connectionId
    ? (state.remoteDetectedAgentIds?.[connectionId] ?? [])
    : (state.detectedAgentIds ?? [])
}

/** Host-detected choices plus providers already proven to run in the workspace. */
export function buildDashboardWorktreeLaunchOptions(
  state: DashboardLaunchOptionState,
  cards: readonly DashboardCard[],
  workspaces: readonly DashboardWorkspace[] = []
): Record<string, TuiAgent[]> {
  const catalog = buildDashboardLaunchCatalog(state)
  const cardsByWorktreeId = new Map<string, DashboardCard[]>()
  const repoIdByWorktreeId = new Map(
    workspaces.map((workspace) => [workspace.worktreeId, workspace.repoId])
  )
  for (const card of cards) {
    repoIdByWorktreeId.set(card.worktreeId, card.repoId)
    const existing = cardsByWorktreeId.get(card.worktreeId)
    if (existing) {
      existing.push(card)
    } else {
      cardsByWorktreeId.set(card.worktreeId, [card])
    }
  }

  const result: Record<string, TuiAgent[]> = {}
  for (const [worktreeId, repoId] of repoIdByWorktreeId) {
    // Past the validator's bound the snapshot itself would be rejected, so the
    // launcher goes quiet for the tail rather than taking the board down.
    if (Object.keys(result).length >= DASHBOARD_MAX_LAUNCH_WORKTREES) {
      break
    }
    const worktreeCards = cardsByWorktreeId.get(worktreeId) ?? []
    const available = new Set<TuiAgent>(
      detectedAgentsForWorktree(state, worktreeId, repoId, catalog)
    )
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
