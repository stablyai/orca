import { automationCanonicalLaunchSetup } from '../../../../../shared/automations/launch/automation-canonical-launch-setup'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { hasAutomationSchedule } from '../../../../../shared/automation-event-triggers'
import { translate } from '@/i18n/i18n'
import { getAutomationRunRepoId } from '../../../../../shared/automations/history/automation-run-identity'
import {
  isRunnableAutomationSchedule,
  tryParseAutomationRrule
} from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AUTOMATION_DEFAULT_TIME, formatTimeInput } from './automation-draft-model'
import { getAutomationSetupDecisionDraftValue } from './automation-setup-decision'

export function buildAutomationEditDraft(automation: Automation): AutomationDraft {
  const setup = automationCanonicalLaunchSetup(automation)
  // An events-only automation's sentinel schedule is no cadence: picking one starts from a new one's.
  const scheduled = hasAutomationSchedule(automation)
  const schedule = scheduled ? tryParseAutomationRrule(automation.rrule) : null
  const hasCustomSchedule = scheduled && !schedule && isRunnableAutomationSchedule(automation.rrule)
  return {
    name: automation.name,
    prompt: automation.prompt,
    agentId: automation.agentId,
    surface: automation.launchSetup?.surface ?? automation.surface ?? 'terminal',
    extraAgentArgs: setup.extraAgentArgs ?? '',
    ...(setup.launchPreferences !== undefined
      ? { launchPreferences: setup.launchPreferences }
      : {}),
    ...(setup.agentArgs !== undefined ? { agentArgs: setup.agentArgs } : {}),
    bot: automation.bot ?? null,
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
    savedSchedule: scheduled ? automation.rrule : null,
    missedRunGraceMinutes: String(automation.missedRunGraceMinutes),
    ...(automation.bot
      ? {
          savedBotAutomation: {
            name: automation.name,
            botId: automation.bot.botId,
            on: automation.on ?? []
          }
        }
      : {}),
    eventsOnly: !scheduled,
    scheduleWarning:
      schedule || hasCustomSchedule || !scheduled
        ? null
        : translate(
            'auto.components.automations.editDraft.unsupportedSchedule',
            'This automation has an unsupported saved schedule. Pick a supported schedule before saving changes.'
          )
  }
}
