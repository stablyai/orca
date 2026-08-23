import React from 'react'
import { CheckCircle2, CircleAlert } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  describeAutomationSchedule,
  getAutomationCronExpressionFields
} from '../../../../shared/automation-schedules'
import { formatUiAutomationScheduleDescriptor } from './automation-schedule-label'
import type { AutomationDraft } from './AutomationEditorDialog'
import { Field } from './automation-page-parts'
import { translate } from '@/i18n/i18n'

const FIELD_CONTROL_CLASS = 'border-input bg-input/30 shadow-xs dark:bg-input/30'

// Why: chip identity is the cron field position, not the copy — two locales may render two fields
// with the same word, and a React key must not change when the UI language does.
const AUTOMATION_CRON_FIELD_IDS = ['minute', 'hour', 'day', 'month', 'weekday'] as const

/** Cron field headers in cron field order, in the configured UI language. */
export function getAutomationCronFieldLabels(): readonly string[] {
  return [
    translate('auto.components.automations.AutomationCustomCronPanel.a226dbdd40', 'Minute'),
    translate('auto.components.automations.AutomationCustomCronPanel.ec9c1e35df', 'Hour'),
    translate('auto.components.automations.AutomationCustomCronPanel.2d82246d23', 'Day'),
    translate('auto.components.automations.AutomationCustomCronPanel.0e1de0358b', 'Month'),
    translate('auto.components.automations.AutomationCustomCronPanel.77e96bded6', 'Weekday')
  ]
}

export function getCronScheduleStatusLabel(
  schedule: string,
  validateSchedule: (schedule: string) => boolean
): { kind: 'empty' | 'invalid' | 'valid'; label: string } {
  const trimmed = schedule.trim()
  if (!trimmed) {
    return {
      kind: 'empty',
      label: translate(
        'auto.components.automations.AutomationCustomCronPanel.968e66d686',
        'Enter a five-field cron.'
      )
    }
  }
  if (!validateSchedule(trimmed)) {
    return {
      kind: 'invalid',
      label: translate(
        'auto.components.automations.AutomationCustomCronPanel.e81a02d61b',
        'Enter a valid five-field cron before saving.'
      )
    }
  }
  // Why: branch on the parsed kind, not on rendered copy — the label is localized.
  const descriptor = describeAutomationSchedule(trimmed)
  if (descriptor.kind === 'custom') {
    return {
      kind: 'valid',
      label: translate(
        'auto.components.automations.AutomationCustomCronPanel.f6ca30da23',
        'Valid custom cron'
      )
    }
  }
  return { kind: 'valid', label: formatUiAutomationScheduleDescriptor(descriptor) }
}

export function getCronFieldValues(schedule: string): readonly string[] {
  const parts = getAutomationCronExpressionFields(schedule)
  return AUTOMATION_CRON_FIELD_IDS.map((_, index) => parts[index] ?? '...')
}

export function AutomationCustomCronPanel({
  draft,
  customScheduleInvalid,
  validateAdvancedSchedule,
  onDraftChange
}: {
  draft: AutomationDraft
  customScheduleInvalid: boolean
  validateAdvancedSchedule: (schedule: string) => boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const customScheduleStatus = getCronScheduleStatusLabel(
    draft.customSchedule,
    validateAdvancedSchedule
  )
  const cronFieldValues = getCronFieldValues(draft.customSchedule)
  const cronFieldLabels = getAutomationCronFieldLabels()

  return (
    <div className="grid gap-3">
      <Field
        label={translate(
          'auto.components.automations.AutomationCustomCronPanel.3e3b2c369f',
          'Cron expression'
        )}
      >
        <Input
          value={draft.customSchedule}
          placeholder="0 9 * * 1-5"
          spellCheck={false}
          className={cn('font-mono', FIELD_CONTROL_CLASS)}
          aria-invalid={customScheduleInvalid}
          aria-describedby="automation-cron-status"
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              customSchedule: event.target.value,
              scheduleWarning: null
            }))
          }
        />
        <div className="mt-2 grid grid-cols-5 gap-1.5">
          {AUTOMATION_CRON_FIELD_IDS.map((fieldId, index) => (
            <div
              key={fieldId}
              className="min-w-0 rounded-md border border-border/70 bg-muted/25 px-1.5 py-1 text-center"
            >
              <div
                className="truncate text-[10px] font-medium text-muted-foreground"
                title={cronFieldLabels[index]}
              >
                {cronFieldLabels[index]}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-foreground">
                {cronFieldValues[index]}
              </div>
            </div>
          ))}
        </div>
        <div
          id="automation-cron-status"
          className={cn(
            'mt-2 flex min-h-8 items-center gap-2 rounded-md border px-2 py-1.5 text-xs',
            customScheduleStatus.kind === 'invalid'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-border/70 bg-muted/30 text-muted-foreground'
          )}
        >
          {customScheduleStatus.kind === 'invalid' ? (
            <CircleAlert className="size-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate">{customScheduleStatus.label}</span>
        </div>
      </Field>
    </div>
  )
}
