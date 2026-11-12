import { capturedAutomationOwner } from '../hosts/automation-captured-owner'
import { toast } from 'sonner'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import { getAutomationTargetAvailability } from '../hosts/automation-target-availability'
import { runAutomationNowForTarget } from '../hosts/automation-host-client'
import { dispatchAutomationRunNow } from '../hosts/automation-row-action-dispatch'
import { waitForAutomationRerunPendingVisibility } from './automation-run-view-state'
import type { AutomationListRow } from '../listing/automation-list-row-identity'
import type { AutomationsPageActionContext } from '../automations-page-action-context'
import type { AutomationRunNowPending } from '../automation-page-state'
import {
  settleAutomationRunNowPending,
  startAutomationRunNowPending
} from './automation-run-now-pending'

/** Run-now/rerun handlers keyed by the selected row's captured host. */
export function createAutomationRunActions({
  store,
  local,
  destination,
  pageRefresh
}: {
  store: Pick<
    AutomationsPageActionContext['store'],
    | 'projectHostSetups'
    | 'sshConnectionStates'
    | 'sshStateByEnvironment'
    | 'runtimeStatusByEnvironmentId'
    | 'repoForRow'
    | 'worktreeForRow'
  >
  local: Pick<
    AutomationsPageActionContext['local'],
    'rerunRunIdsInFlightRef' | 'setRerunRunIdsInFlight' | 'setRunNowPending'
  >
  destination: Pick<
    AutomationsPageActionContext['destination'],
    | 'automationHostTargetFor'
    | 'automationDispatchContext'
    | 'reportOwnerAction'
    | 'invalidateRowHost'
  >
  pageRefresh: Pick<
    AutomationsPageActionContext['pageRefresh'],
    'hydratePersistedUIState' | 'refresh'
  >
}) {
  const {
    projectHostSetups,
    sshConnectionStates,
    sshStateByEnvironment,
    runtimeStatusByEnvironmentId,
    repoForRow,
    worktreeForRow
  } = store
  const { rerunRunIdsInFlightRef, setRerunRunIdsInFlight, setRunNowPending } = local
  const {
    automationHostTargetFor,
    automationDispatchContext,
    reportOwnerAction,
    invalidateRowHost
  } = destination

  const runNow = async (row: AutomationListRow): Promise<void> => {
    const repo = repoForRow(row) ?? null
    const workspace = row.automation.workspaceId
      ? (worktreeForRow(row, repo ?? undefined) ?? null)
      : null
    const rowHostTarget = automationHostTargetFor(row)
    const availability = getAutomationTargetAvailability({
      automation: row.automation,
      capturedOwner: capturedAutomationOwner(automationDispatchContext.capturedOwners, row.key),
      repo,
      workspace,
      projectHostSetups,
      sshConnectionStates,
      sshStateByEnvironment,
      runtimeStatusByEnvironmentId,
      automationHostTarget: rowHostTarget
    })
    if (!availability.canRunNow) {
      toast.error(availability.message)
      return
    }
    // Why: the detail's Run now stays busy until the run it started is listed, so a
    // second click can't queue a duplicate; a scheduled run in progress never blocks it.
    const requestId = createNonSecureContextUuid()
    const settle = (
      update: (current: AutomationRunNowPending) => AutomationRunNowPending | null
    ): void =>
      setRunNowPending((byRow) => settleAutomationRunNowPending(byRow, row.key, requestId, update))
    setRunNowPending((byRow) =>
      startAutomationRunNowPending(byRow, {
        requestId,
        rowKey: row.key,
        requestedAt: Date.now(),
        acknowledgedAt: null,
        runId: null
      })
    )
    let result: Awaited<ReturnType<typeof dispatchAutomationRunNow>>
    try {
      result = await dispatchAutomationRunNow(
        automationDispatchContext,
        { rowKey: row.key, automationId: row.automation.id },
        () => runAutomationNowForTarget(row.automation, rowHostTarget)
      )
    } catch (error) {
      settle(() => null)
      throw error
    }
    reportOwnerAction(row.key, result.ok ? null : result.notice)
    if (!result.ok) {
      settle(() => null)
      return
    }
    const startedRunId = result.value?.id ?? null
    settle((current) => ({ ...current, runId: startedRunId, acknowledgedAt: Date.now() }))
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
