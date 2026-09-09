import { toast } from 'sonner'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  isValidAutomationCronSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedule-parsing'
import { translate } from '@/i18n/i18n'
import { parseDraftTime } from './automation-draft-model'
import { saveHermesAutomation } from './automation-hermes-save'
import { saveOrcaAutomation } from './automation-orca-save'
import type { AutomationSaveContext } from './automation-save-context'

/** Validates editor input then delegates the provider-specific save transaction. */
export function createAutomationSaveAction(context: AutomationSaveContext) {
  return async function saveAutomation(now = Date.now()): Promise<void> {
    const { store, local, destinationForm, destination } = context
    const { settings } = store
    const {
      draft,
      editingAutomationId,
      createTarget,
      editingExternalTarget,
      setIsSaving,
      setEditorNotice
    } = local
    const isHermesSave =
      editingAutomationId === null && (createTarget === 'hermes' || editingExternalTarget !== null)
    const { hour, minute } = parseDraftTime(draft.time)
    if (
      !draft.projectId ||
      ((draft.workspaceMode === 'existing' || isHermesSave) && !draft.workspaceId) ||
      !draft.prompt.trim()
    ) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.2430fecf53',
          'Choose a run location and enter a prompt before saving.'
        )
      )
      return
    }
    if (draft.scheduleWarning) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.64bdb2304f',
          'Pick a supported schedule before saving.'
        )
      )
      return
    }
    const validateAdvancedSchedule = isHermesSave
      ? isValidAutomationCronSchedule
      : isValidAutomationSchedule
    if (draft.preset === 'custom' && !validateAdvancedSchedule(draft.customSchedule)) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.6e91dab317',
          'Enter a valid advanced schedule before saving.'
        )
      )
      return
    }
    if (
      editingAutomationId === null &&
      !isHermesSave &&
      !isTuiAgentEnabled(draft.agentId, settings?.disabledTuiAgents)
    ) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.2360ffc956',
          'Choose an enabled agent before saving.'
        )
      )
      return
    }
    setIsSaving(true)
    try {
      const selectedWorkspaceExists =
        draft.workspaceMode !== 'existing' ||
        destinationForm.dialogWorktrees.some((worktree) => worktree.id === draft.workspaceId)
      if (!selectedWorkspaceExists) {
        toast.error(
          translate(
            'auto.components.automations.AutomationsPage.32534e7c9c',
            'Choose an available workspace before saving.'
          )
        )
        return
      }
      if (!isHermesSave && editingAutomationId === null) {
        const checked = destination.createDestination.check(draft.projectId)
        if (!checked.ok) {
          setEditorNotice(checked.notice)
          return
        }
      }
      await (isHermesSave
        ? saveHermesAutomation(context)
        : saveOrcaAutomation(context, { hour, minute, now }))
    } catch (error) {
      if (isHermesSave) {
        await context.pageRefresh.refresh().catch(() => undefined)
      }
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.b11170a008',
              'Failed to save automation.'
            )
      )
    } finally {
      setIsSaving(false)
    }
  }
}

export type AutomationSaveAction = ReturnType<typeof createAutomationSaveAction>
