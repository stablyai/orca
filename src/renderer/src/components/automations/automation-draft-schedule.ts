import { buildAutomationRrule } from '../../../../shared/automation-schedule-occurrences'
import {
  automationOnceRunAt,
  buildAutomationOnceSchedule
} from '../../../../shared/automation-once-schedule'
import type { AutomationDraft } from './AutomationEditorDialog'

export function buildAutomationDraftSchedule(
  draft: AutomationDraft,
  time: { hour: number; minute: number }
): string {
  if (draft.preset === 'custom') {
    return draft.customSchedule.trim()
  }
  if (draft.preset === 'once') {
    return buildAutomationOnceSchedule(
      automationOnceRunAt(draft.onceDate ?? '', draft.time) ?? Number.NaN
    )
  }
  return buildAutomationRrule({
    preset: draft.preset,
    hour: time.hour,
    minute: time.minute,
    dayOfWeek: Number(draft.dayOfWeek)
  })
}
