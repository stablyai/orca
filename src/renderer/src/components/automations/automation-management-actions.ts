import { deleteAutomationForTarget, updateAutomationForTarget } from './automation-host-client'
import {
  dispatchAutomationDelete,
  dispatchAutomationUpdate
} from './automation-row-action-dispatch'
import { persistSkipDeleteAutomationConfirm } from './automation-delete-confirm-preference'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationsPageActionContext } from './automations-page-action-context'

/** Fenced toggle/delete handlers and the confirmation preference flow. */
export function createAutomationManagementActions({
  store,
  local,
  destination,
  pageRefresh
}: AutomationsPageActionContext) {
  const { updateSettings, openSettingsPage, openSettingsTarget, settings } = store
  const {
    selectAutomationId,
    selectedRowKey,
    setSelectedAutomationRunPageId,
    setActivePaneTab,
    setIsDetailOpen,
    setDontAskDeleteAgain,
    setDeleteTarget,
    deleteTarget,
    dontAskDeleteAgain
  } = local
  const {
    automationHostTargetFor,
    automationDispatchContext,
    reportOwnerAction,
    invalidateRowHost
  } = destination

  const toggleAutomation = async (row: AutomationListRow): Promise<void> => {
    const result = await dispatchAutomationUpdate(
      automationDispatchContext,
      { rowKey: row.key, automationId: row.automation.id },
      { enabled: !row.automation.enabled },
      () =>
        updateAutomationForTarget(
          row.automation,
          { enabled: !row.automation.enabled },
          automationHostTargetFor(row)
        )
    )
    reportOwnerAction(row.key, result.ok ? null : result.notice)
    if (result.ok) {
      invalidateRowHost(row.key, 'definition')
    }
    await pageRefresh.refresh()
  }

  const deleteAutomation = async (row: AutomationListRow): Promise<void> => {
    const result = await dispatchAutomationDelete(
      automationDispatchContext,
      { rowKey: row.key, automationId: row.automation.id },
      () => deleteAutomationForTarget(row.automation, automationHostTargetFor(row))
    )
    reportOwnerAction(row.key, result.ok ? null : result.notice)
    if (result.ok) {
      if (selectedRowKey === row.key) {
        selectAutomationId(null)
        setIsDetailOpen(false)
        setSelectedAutomationRunPageId(null)
        setActivePaneTab('overview')
      }
      invalidateRowHost(row.key, 'definition')
    }
    await pageRefresh.refresh()
  }

  const persistDeleteAutomationPreference = (): void => {
    persistSkipDeleteAutomationConfirm({ updateSettings, openSettingsPage, openSettingsTarget })
  }

  const requestDeleteAutomation = (row: AutomationListRow): void => {
    if (settings?.skipDeleteAutomationConfirm) {
      void deleteAutomation(row)
      return
    }
    setDontAskDeleteAgain(false)
    setDeleteTarget(row)
  }
  const confirmDeleteAutomation = async (): Promise<void> => {
    if (!deleteTarget) {
      return
    }
    if (dontAskDeleteAgain) {
      persistDeleteAutomationPreference()
    }
    const target = deleteTarget
    setDeleteTarget(null)
    setDontAskDeleteAgain(false)
    await deleteAutomation(target)
  }

  return { toggleAutomation, deleteAutomation, requestDeleteAutomation, confirmDeleteAutomation }
}

export type AutomationManagementActions = ReturnType<typeof createAutomationManagementActions>
