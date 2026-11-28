import { toast } from 'sonner'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../../shared/automations/external/external-automation'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  externalAutomationActionKey,
  externalAutomationJobKey
} from './external-automation-scope-keys'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import type { AutomationsPageActionContext } from '../automations-page-action-context'

async function executeExternalAutomationAction({
  local,
  list,
  pageRefresh,
  scope,
  job,
  action,
  t
}: Pick<AutomationsPageActionContext, 'local' | 'list' | 'pageRefresh'> & {
  scope: ExternalAutomationScope
  job: ExternalAutomationJob
  action: ExternalAutomationAction
  t: Translate
}): Promise<void> {
  const {
    setExternalActionKey,
    selectedExternalKeyRef,
    selectExternalKey,
    setIsDetailOpen,
    setActivePaneTab
  } = local
  const { scopedExternal } = list

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
        ? t(
            'auto.components.automations.AutomationsPage.4c22bc9913',
            'External automation deleted.'
          )
        : action === 'run'
          ? t(
              'auto.components.automations.AutomationsPage.4d7878402c',
              'External automation queued.'
            )
          : action === 'pause'
            ? t(
                'auto.components.automations.AutomationsPage.77c518a34b',
                'External automation paused.'
              )
            : t(
                'auto.components.automations.AutomationsPage.37288942f0',
                'External automation resumed.'
              )
    )
  } catch (error) {
    await pageRefresh.refresh().catch(() => undefined)
    toast.error(
      error instanceof Error
        ? error.message
        : t(
            'auto.components.automations.AutomationsPage.126d726546',
            'External automation action failed.'
          )
    )
  } finally {
    setExternalActionKey(null)
  }
}

/** External manager actions always carry the scope that produced their row. */
export function useExternalAutomationActions({
  local,
  list,
  pageRefresh
}: AutomationsPageActionContext) {
  const t = useTranslate()
  const { setSelectedAutomationRunPageId, setExternalDeleteTarget, externalDeleteTarget } = local

  const runExternalAction = (
    scope: ExternalAutomationScope,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): Promise<void> =>
    executeExternalAutomationAction({ local, list, pageRefresh, scope, job, action, t })

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
    openAutomationRunPage,
    requestExternalAction,
    confirmDeleteExternalAutomation
  }
}

export type ExternalAutomationActions = ReturnType<typeof useExternalAutomationActions>
