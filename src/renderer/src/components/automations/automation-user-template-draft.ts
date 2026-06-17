import type {
  UserAutomationTemplate,
  UserAutomationTemplateInput
} from '../../../../shared/automations-types'
import type { AutomationDraft } from './AutomationEditorDialog'
import { agentConfigToDraftFields, draftToAgentConfig } from './automation-agent-config-draft'

/** Build a persisted-template input from the current draft's soft fields. The
 *  run target (project/workspace), precheck, and webhook are intentionally
 *  excluded — those are chosen per automation when the template is applied. */
export function draftToUserTemplateInput(
  draft: AutomationDraft,
  label: string,
  description: string
): UserAutomationTemplateInput {
  return {
    label,
    description,
    name: draft.name,
    prompt: draft.prompt,
    agentId: draft.agentId,
    agentConfig: draftToAgentConfig(draft),
    preset: draft.preset,
    time: draft.time,
    dayOfWeek: draft.dayOfWeek,
    customSchedule: draft.customSchedule,
    missedRunGraceMinutes: draft.missedRunGraceMinutes
  }
}

/** Merge a user template's soft fields onto an existing draft, leaving the run
 *  target and other per-automation fields untouched. */
export function applyUserTemplateToDraft(
  current: AutomationDraft,
  template: UserAutomationTemplate
): AutomationDraft {
  return {
    ...current,
    name: template.name,
    prompt: template.prompt,
    agentId: template.agentId,
    preset: template.preset,
    // Why: never leave time blank — an empty time would silently build a
    // midnight schedule rather than failing validation.
    time: template.time ?? (current.time || '09:00'),
    dayOfWeek: template.dayOfWeek ?? current.dayOfWeek,
    customSchedule: template.customSchedule ?? '',
    missedRunGraceMinutes: template.missedRunGraceMinutes ?? current.missedRunGraceMinutes,
    scheduleWarning: null,
    ...agentConfigToDraftFields(template.agentConfig)
  }
}
