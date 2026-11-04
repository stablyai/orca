import type { Automation } from '../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import {
  isRunnableAutomationSchedule,
  tryParseAutomationRrule
} from '../../../../shared/automation-schedule-parsing'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AUTOMATION_DEFAULT_TIME, formatTimeInput } from './automation-draft-model'
import { getAutomationSetupDecisionDraftValue } from './automation-setup-decision'

export function buildAutomationEditDraft(automation: Automation): AutomationDraft {
  const schedule = tryParseAutomationRrule(automation.rrule)
  const hasCustomSchedule = !schedule && isRunnableAutomationSchedule(automation.rrule)
  return {
    name: automation.name,
    prompt: automation.prompt,
    agentId: automation.agentId,
    surface: automation.launchSetup?.surface ?? automation.surface ?? 'terminal',
    extraAgentArgs: automation.extraAgentArgs ?? '',
    projectId: getAutomationRunRepoId(automation),
    workspaceMode: automation.workspaceMode,
    workspaceId: automation.workspaceId ?? '',
    baseBranch: automation.baseBranch ?? '',
    setupDecision: getAutomationSetupDecisionDraftValue({
      workspaceMode: automation.workspaceMode,
      persistedSetupDecision: automation.setupDecision
    }),
    reuseSession: automation.workspaceMode === 'existing' && automation.reuseSession,
    precheckCommand: automation.precheck?.command ?? '',
    precheckTimeoutSeconds: String(automation.precheck?.timeoutSeconds ?? 60),
    preset: schedule?.preset ?? (hasCustomSchedule ? 'custom' : 'weekdays'),
    time: schedule ? formatTimeInput(schedule.hour, schedule.minute) : AUTOMATION_DEFAULT_TIME,
    dayOfWeek: String(schedule?.dayOfWeek ?? 1),
    customSchedule: hasCustomSchedule ? automation.rrule : '',
    savedSchedule: automation.rrule,
    missedRunGraceMinutes: String(automation.missedRunGraceMinutes),
    scheduleWarning:
      schedule || hasCustomSchedule
        ? null
        : translate(
            'auto.components.automations.editDraft.unsupportedSchedule',
            'This automation has an unsupported saved schedule. Pick a supported schedule before saving changes.'
          )
  }
}
