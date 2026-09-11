import { toast } from 'sonner'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeGroupBy } from '../sidebar/worktree-list/grouping/row-types'
import { getFolderWorkspaceRevealGroupKeys } from '../sidebar/worktree-list/navigation/folder-reveal'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { runAutomationNowForTarget } from './automation-host-client'
import { dispatchAutomationRunNow } from './automation-row-action-dispatch'
import { waitForAutomationRerunPendingVisibility } from './automation-run-view-state'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationsPageActionContext } from './automations-page-action-context'

/**
 * Why: #20113 — Reveal the workspace's ancestor project groups when an automation run starts,
 * so work happening in a collapsed folder is visible to the user without scrolling or stealing focus.
 */
export function expandProjectFolderOnAutomationRun(
  workspaceId: string | null | undefined,
  executionHostId?: ExecutionHostId | null
): void {
  if (!workspaceId) {
    return
  }
  try {
    const store = useAppStore.getState() as {
      settings?: { expandProjectFolderOnAutomationRun?: boolean }
      folderWorkspaces?: readonly FolderWorkspace[]
      projectGroups?: readonly ProjectGroup[]
      worktrees?: readonly Worktree[]
      repoMap?: ReadonlyMap<string, Repo>
      groupBy?: WorktreeGroupBy
      workspaceStatuses?: readonly WorkspaceStatusDefinition[]
      defaultHostId?: ExecutionHostId
      uncollapseSidebarGroups?: (keys: readonly string[]) => void
    }
    if (store.settings?.expandProjectFolderOnAutomationRun === false) {
      return
    }
    const keys = getFolderWorkspaceRevealGroupKeys(
      workspaceId,
      store.folderWorkspaces ?? [],
      store.projectGroups ?? [],
      {
        groupBy: store.groupBy,
        workspaceStatuses: store.workspaceStatuses,
        defaultHostId: store.defaultHostId,
        worktrees: store.worktrees,
        repoMap: store.repoMap,
        executionHostId
      }
    )
    if (keys.length > 0) {
      store.uncollapseSidebarGroups?.(keys)
    }
  } catch (error) {
    console.warn('[automations] failed to expand project folder on run start:', error)
  }
}

/** Run-now/rerun handlers keyed by the selected row's captured host. */
export function createAutomationRunActions({
  store,
  local,
  destination,
  sourceAvailability,
  pageRefresh
}: AutomationsPageActionContext) {
  const {
    projectHostSetups,
    sshConnectionStates,
    runtimeStatusByEnvironmentId,
    repoForRow,
    worktreeForRow
  } = store
  const { rerunRunIdsInFlightRef, setRerunRunIdsInFlight } = local
  const {
    automationHostTargetFor,
    automationDispatchContext,
    reportOwnerAction,
    invalidateRowHost
  } = destination
  const { automationSourceHostAvailabilityByRowKey } = sourceAvailability

  const runNow = async (row: AutomationListRow): Promise<void> => {
    const repo = repoForRow(row) ?? null
    const workspace = row.automation.workspaceId
      ? (worktreeForRow(row, repo ?? undefined) ?? null)
      : null
    const rowHostTarget = automationHostTargetFor(row)
    const availability = getAutomationTargetAvailability({
      automation: row.automation,
      repo,
      workspace,
      projectHostSetups,
      sshConnectionStates,
      runtimeStatusByEnvironmentId,
      automationHostTarget: rowHostTarget,
      sourceHostAvailability: automationSourceHostAvailabilityByRowKey.get(row.key)
    })
    if (!availability.canRunNow) {
      toast.error(availability.message)
      return
    }
    const result = await dispatchAutomationRunNow(
      automationDispatchContext,
      { rowKey: row.key, automationId: row.automation.id },
      () => runAutomationNowForTarget(row.automation, rowHostTarget)
    )
    reportOwnerAction(row.key, result.ok ? null : result.notice)
    if (!result.ok) {
      return
    }
    expandProjectFolderOnAutomationRun(
      row.automation.workspaceId,
      workspace?.hostId ?? row.automation.runContext?.hostId
    )
    useAppStore.getState().recordFeatureInteraction('automation-run')
    invalidateRowHost(row.key, 'run')
    await pageRefresh.hydratePersistedUIState()
    await pageRefresh.refresh()
    toast.message(
      translate('auto.components.automations.AutomationsPage.a1bdb57008', 'Automation run queued.')
    )
  }

  const rerunAutomationRun = async (row: AutomationListRow, run: AutomationRun): Promise<void> => {
    const runId = run.id
    if (rerunRunIdsInFlightRef.current.has(runId)) {
      return
    }
    const repo = repoForRow(row) ?? null
    const targetWorkspaceId = run.workspaceId ?? row.automation.workspaceId
    const workspace = targetWorkspaceId
      ? (worktreeForRow(row, repo ?? undefined, targetWorkspaceId) ?? null)
      : null
    const pendingStartedAt = Date.now()
    rerunRunIdsInFlightRef.current.add(runId)
    setRerunRunIdsInFlight(new Set(rerunRunIdsInFlightRef.current))
    try {
      const result = await dispatchAutomationRunNow(
        automationDispatchContext,
        { rowKey: row.key, automationId: row.automation.id },
        () => runAutomationNowForTarget(row.automation, automationHostTargetFor(row))
      )
      reportOwnerAction(row.key, result.ok ? null : result.notice)
      if (!result.ok) {
        await pageRefresh.refresh()
        return
      }
      expandProjectFolderOnAutomationRun(
        targetWorkspaceId,
        workspace?.hostId ?? row.automation.runContext?.hostId
      )
      invalidateRowHost(row.key, 'run')
      await pageRefresh.hydratePersistedUIState()
      await pageRefresh.refresh()
      toast.message(
        translate(
          'auto.components.automations.AutomationsPage.a1bdb57008',
          'Automation run queued.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.3a4c476aa0',
              'Failed to rerun automation.'
            )
      )
      await pageRefresh.refresh()
    } finally {
      await waitForAutomationRerunPendingVisibility(pendingStartedAt)
      rerunRunIdsInFlightRef.current.delete(runId)
      setRerunRunIdsInFlight(new Set(rerunRunIdsInFlightRef.current))
    }
  }

  return { runNow, rerunAutomationRun }
}

export type AutomationRunActions = ReturnType<typeof createAutomationRunActions>
