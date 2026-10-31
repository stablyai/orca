import type { Automation } from '../../../../shared/automations-types'
import { useAppStore } from '@/store'
import type { AutomationCreateDestination } from './automation-create-destination'
import type { AutomationSaveContext } from './automation-save-context'
import { showAutomationSavedToast } from './automation-orca-save-operations'

export async function completeAutomationSave(
  context: AutomationSaveContext,
  automation: Automation,
  moveTarget: AutomationCreateDestination | null,
  originalRemoved: boolean
): Promise<void> {
  const { local, destination, pageRefresh } = context
  const {
    editingAutomationId,
    editingRowKey,
    setAutomations,
    setDraft,
    setSelectedAutomationRunPageId,
    setSelectedRowKey,
    selectAutomationId,
    setCreateOpen
  } = local
  const { invalidateRowHost } = destination
  if (editingAutomationId !== null) {
    invalidateRowHost(editingRowKey, 'definition')
  } else {
    await pageRefresh.hydratePersistedUIState()
  }
  setAutomations((current) => {
    const next = current.filter((entry) => entry.id !== automation.id)
    return [...next, automation].sort((left, right) => left.name.localeCompare(right.name))
  })
  setDraft((current) => ({ ...current, name: '', prompt: '' }))
  await pageRefresh.refresh()
  if (editingAutomationId !== null && editingRowKey && !moveTarget) {
    setSelectedAutomationRunPageId(null)
    setSelectedRowKey(editingRowKey)
  }
  selectAutomationId(automation.id)
  setCreateOpen(false)
  if (editingAutomationId === null) {
    useAppStore.getState().recordFeatureInteraction('automation-created')
  }
  if (moveTarget && !originalRemoved) {
    return
  }
  showAutomationSavedToast(moveTarget, editingAutomationId)
}
