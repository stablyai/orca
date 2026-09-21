import { useCallback } from 'react'
import { toast } from 'sonner'
import type {
  AutomationRun,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun
} from '../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { FetchExternalAutomationRuns } from './ExternalAutomationRunTable'
import { isMissingExternalRunsApiError } from './external-automation-display'
import {
  externalAutomationActionKey,
  externalAutomationJobKey
} from './external-automation-scope-keys'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import type { AutomationsPageActionContext } from './automations-page-action-context'

/** External manager actions always carry the scope that produced their row. */
export function useExternalAutomationActions({
  local,
  list,
  pageRefresh
}: AutomationsPageActionContext) {
  const {
    setExternalActionKey,
    setSelectedExternalRunPage,
    setSelectedAutomationRunPageId,
    setExternalDeleteTarget,
    externalDeleteTarget,
    selectedExternalKeyRef,
    selectExternalKey,
    setIsDetailOpen,
    setActivePaneTab
  } = local
  const { scopedExternal } = list
  const fetchScopedExternalRuns = scopedExternal.fetchRuns

  const runExternalAction = async (
    scope: ExternalAutomationScope,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): Promise<void> => {
    setExternalActionKey(externalAutomationActionKey(scope, job.id, action))
    try {
      await scopedExternal.runExternalAction(scope, job.id, action)
      if (action === 'run') {
        useAppStore.getState().recordFeatureInteraction('automation-run')
      }
      await pageRefresh.refresh({ awaitExternalManagers: true })
      if (action === 'delete') {
        const deletedKey = externalAutomationJobKey(scope, job.id)
        if (selectedExternalKeyRef.current === deletedKey) {
          selectExternalKey(null)
          setIsDetailOpen(false)
          setActivePaneTab('overview')
        }
      }
      toast.success(
        action === 'delete'
          ? translate(
              'auto.components.automations.AutomationsPage.4c22bc9913',
              'External automation deleted.'
            )
          : action === 'run'
            ? translate(
                'auto.components.automations.AutomationsPage.4d7878402c',
                'External automation queued.'
              )
            : action === 'pause'
              ? translate(
                  'auto.components.automations.AutomationsPage.77c518a34b',
                  'External automation paused.'
                )
              : translate(
                  'auto.components.automations.AutomationsPage.37288942f0',
                  'External automation resumed.'
                )
      )
    } catch (error) {
      await pageRefresh.refresh().catch(() => undefined)
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.126d726546',
              'External automation action failed.'
            )
      )
    } finally {
      setExternalActionKey(null)
    }
  }

  const fetchExternalAutomationRuns = useCallback<FetchExternalAutomationRuns>(
    async ({ scope, job, page, pageSize }) => {
      try {
        const result = await fetchScopedExternalRuns(scope, job, page, pageSize)
        return { runs: [...result.runs], totalCount: result.totalCount }
      } catch (error) {
        if (isMissingExternalRunsApiError(error)) {
          return {
            runs: job.runs.slice(page * pageSize, page * pageSize + pageSize),
            totalCount: job.runCount
          }
        }
        throw error
      }
    },
    [fetchScopedExternalRuns]
  )
  const openExternalRunPage = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    run: ExternalAutomationRun
  ): void => {
    setSelectedExternalRunPage({ manager, job, run })
  }
  const openAutomationRunPage = (run: AutomationRun): void => {
    setSelectedAutomationRunPageId(run.id)
  }
  const requestExternalAction = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction,
    scope: ExternalAutomationScope
  ): void => {
    if (action === 'delete') {
      setExternalDeleteTarget({ manager, job, scope })
      return
    }
    void runExternalAction(scope, job, action)
  }
  const confirmDeleteExternalAutomation = async (): Promise<void> => {
    if (!externalDeleteTarget) {
      return
    }
    const target = externalDeleteTarget
    setExternalDeleteTarget(null)
    await runExternalAction(target.scope, target.job, 'delete')
  }

  return {
    runExternalAction,
    fetchExternalAutomationRuns,
    openExternalRunPage,
    openAutomationRunPage,
    requestExternalAction,
    confirmDeleteExternalAutomation
  }
}

export type ExternalAutomationActions = ReturnType<typeof useExternalAutomationActions>
