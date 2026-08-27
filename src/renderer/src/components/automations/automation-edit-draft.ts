/**
 * Turns a saved record back into the editor's draft shape.
 *
 * Both builders are total: a schedule the editor cannot represent produces a
 * warning rather than a silently rewritten one, because saving would otherwise
 * replace a working cron the user never chose to change.
 */

import type { Automation, ExternalAutomationJob } from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import {
  isValidAutomationCronSchedule,
  isValidAutomationSchedule,
  tryParseAutomationRrule
} from '../../../../shared/automation-schedules'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AUTOMATION_DEFAULT_TIME, formatTimeInput } from './automation-draft-model'
import { getAutomationSetupDecisionDraftValue } from './automation-setup-decision'

export function buildAutomationEditDraft(automation: Automation): AutomationDraft {
  const schedule = tryParseAutomationRrule(automation.rrule)
  const hasCustomSchedule = !schedule && isValidAutomationSchedule(automation.rrule)
  return {
    name: automation.name,
    prompt: automation.prompt,
    agentId: automation.agentId,
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
    missedRunGraceMinutes: String(automation.missedRunGraceMinutes),
    scheduleWarning:
      schedule || hasCustomSchedule
        ? null
        : 'This automation has an unsupported saved schedule. Pick a supported schedule before saving changes.'
  }
}

export function buildExternalAutomationEditDraft(
  job: ExternalAutomationJob,
  placement: { projectId: string; workspaceId: string }
): AutomationDraft {
  const rawSchedule = job.rawSchedule?.trim() ?? ''
  const hasCustomSchedule = isValidAutomationCronSchedule(rawSchedule)
  return {
    name: job.name,
    prompt: job.prompt ?? job.promptPreview,
    agentId: 'hermes',
    projectId: placement.projectId,
    workspaceMode: 'existing',
    workspaceId: placement.workspaceId,
    baseBranch: '',
    setupDecision: undefined,
    reuseSession: false,
    precheckCommand: '',
    precheckTimeoutSeconds: '60',
    preset: hasCustomSchedule ? 'custom' : 'weekdays',
    time: AUTOMATION_DEFAULT_TIME,
    dayOfWeek: '1',
    customSchedule: hasCustomSchedule ? rawSchedule : '',
    missedRunGraceMinutes: '720',
    scheduleWarning: hasCustomSchedule
      ? null
      : 'This Hermes automation has an unsupported saved schedule. Pick a supported schedule before saving changes.'
  }
}
