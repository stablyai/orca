import { toast } from 'sonner'
import type { AutomationRun } from '../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { runAutomationNowForTarget } from './automation-host-client'
import { dispatchAutomationRunNow } from './automation-row-action-dispatch'
import { waitForAutomationRerunPendingVisibility } from './automation-run-view-state'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationsPageActionContext } from './automations-page-action-context'

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
