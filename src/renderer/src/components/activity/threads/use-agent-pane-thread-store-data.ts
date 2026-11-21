import { selectVisibleAgentOrchestration } from '@/runtime/agent-orchestration/visible-agent-orchestration'
import {
  getStructuredAgentSessionTabs,
  type StructuredTab
} from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { useAppStore } from '@/store'
import { sameAcceptedStatusRevision } from '@/store/slices/agent-status/status-ownership/agent-status-revisions'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { AppState } from '@/store/types'
import {
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { advanceActivityTabs, type ActivityTabProjection } from '../events/activity-tab-projection'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

export type AllAgentPaneThreadsStoreData = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'repos'
  | 'projectGroups'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
  | 'detectedWorktreesByRepo'
  | 'getKnownWorktreeById'
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'acknowledgeAgents'
  | 'unacknowledgeAgents'
> & {
  /** Current native-chat originals and terminal tabs with semantic identity reuse. */
  activityTabs: ActivityTabProjection
  /** Same list while no chat tab changes; the builder indexes it by pane key only when a pane needs it. */
  structuredTabs: readonly StructuredTab[]
  worktreeMap: ReturnType<typeof getIndexedWorktreeMap>
  repoMap: ReturnType<typeof getIndexedRepoMap>
  generatedTitlesEnabled: boolean
}

export type AgentPaneThreadsStoreData = AllAgentPaneThreadsStoreData & {
  /** Focused-host fallback for hostless worktrees, shared by the scope filter and the row actions. */
  defaultHostId: ExecutionHostId
}

/** Focused-host fallback for the scope filter and row actions; the unscoped list never reads it. */
export function useAgentPaneThreadsDefaultHostId(): ExecutionHostId {
  return useAppStore((s) => getSettingsFocusedExecutionHostId(s.settings))
}

// Window-wide so every consumer passes the same tab identities to the shared Activity projection.
// Keep original native tabs for owner-qualified names; preserve terminal projections across focus writes.
let tabProjection: {
  raw: AppState['unifiedTabsByWorktree'] | null
  projected: ActivityTabProjection | null
} = { raw: null, projected: null }

/** Drop the window-wide tab projection once no Activity reader is mounted. */
export function releaseActivityTabProjection(): void {
  tabProjection = { raw: null, projected: null }
}

function selectActivityTabs(raw: AppState['unifiedTabsByWorktree']): ActivityTabProjection {
  if (tabProjection.raw === raw && tabProjection.projected) {
    return tabProjection.projected
  }
  const projected = advanceActivityTabs(raw, tabProjection.raw, tabProjection.projected)
  tabProjection = { raw, projected }
  return projected
}

/** Store inputs for every Activity thread, before any view scope; compare shallowly. */
export function selectAllAgentPaneThreadStoreData(
  s: AppState,
  previous?: AllAgentPaneThreadsStoreData
): AllAgentPaneThreadsStoreData {
  const previousStatuses = previous?.agentStatusByPaneKey
  return {
    agentStatusByPaneKey:
      previousStatuses &&
      sameAcceptedStatusRevision(
        previousStatuses,
        s.agentStatusByPaneKey,
        'activityDetailsRevision'
      )
        ? previousStatuses
        : s.agentStatusByPaneKey,
    runtimeAgentOrchestrationByPaneKey: selectVisibleAgentOrchestration(s),
    migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
    tabsByWorktree: s.tabsByWorktree,
    ptyIdsByTabId: s.ptyIdsByTabId,
    activityTabs: selectActivityTabs(s.unifiedTabsByWorktree),
    structuredTabs: getStructuredAgentSessionTabs(s.unifiedTabsByWorktree),
    repos: s.repos,
    // Read by getKnownWorktreeById for folder owners, so a change must rebuild Activity owners.
    projectGroups: s.projectGroups,
    worktreesByRepo: selectWorktreesByRepo(s),
    folderWorkspaces: selectFolderWorkspaces(s),
    floatingWorkspacePath: s.floatingWorkspacePath,
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(s),
    getKnownWorktreeById: s.getKnownWorktreeById,
    worktreeMap: getIndexedWorktreeMap(selectWorktreesByRepo(s)),
    repoMap: getIndexedRepoMap(s.repos),
    acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey: s.activityClearedAtByPaneKey,
    acknowledgeAgents: s.acknowledgeAgents,
    unacknowledgeAgents: s.unacknowledgeAgents,
    generatedTitlesEnabled: s.settings?.tabAutoGenerateTitle === true
  }
}
