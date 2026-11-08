import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { selectVisibleAgentOrchestration } from '@/runtime/agent-orchestration/visible-agent-orchestration'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { AppState } from '@/store/types'
import {
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { projectActivityTabs, type ActivityTabProjection } from './activity-tab-projection'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

export type AgentPaneThreadsStoreData = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
  | 'repos'
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
  worktreeMap: ReturnType<typeof getIndexedWorktreeMap>
  repoMap: ReturnType<typeof getIndexedRepoMap>
  generatedTitlesEnabled: boolean
  /** Focused-host fallback for hostless worktrees, shared by the scope filter and the row actions. */
  defaultHostId: ExecutionHostId
}

export function useAgentPaneThreadStoreData(): AgentPaneThreadsStoreData {
  // Keep original native tabs for owner-qualified names; preserve terminal projections across focus writes.
  const tabProjectionRef = useRef<{
    raw: AppState['unifiedTabsByWorktree'] | null
    projected: ActivityTabProjection | null
  }>({ raw: null, projected: null })
  return useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      runtimeAgentOrchestrationByPaneKey: selectVisibleAgentOrchestration(s),
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      activityTabs: (() => {
        const cache = tabProjectionRef.current
        if (cache.raw === s.unifiedTabsByWorktree && cache.projected) {
          return cache.projected
        }
        const projected = projectActivityTabs(s.unifiedTabsByWorktree, cache.projected)
        tabProjectionRef.current = { raw: s.unifiedTabsByWorktree, projected }
        return projected
      })(),
      repos: s.repos,
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
      generatedTitlesEnabled: s.settings?.tabAutoGenerateTitle === true,
      defaultHostId: getSettingsFocusedExecutionHostId(s.settings)
    }))
  )
}
