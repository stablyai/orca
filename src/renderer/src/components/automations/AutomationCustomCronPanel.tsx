import React from 'react'
import { CheckCircle2, CircleAlert, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatAutomationSchedule } from '../../../../shared/automation-schedules'
import type { AutomationDraft } from './AutomationEditorDialog'
import { Field } from './automation-page-parts'

const FIELD_CONTROL_CLASS = 'border-input bg-input/30 shadow-xs dark:bg-input/30'

export const AUTOMATION_CRON_QUICK_STARTS = [
  { label: 'Every 15 min', expression: '*/15 * * * *' },
  { label: 'Hourly workday', expression: '0 9-17 * * 1-5' },
  { label: 'Weekdays 9 AM', expression: '0 9 * * 1-5' },
  { label: 'Monthly audit', expression: '0 9 1 * *' }
] as const

export const AUTOMATION_CRON_FIELD_LABELS = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'] as const

export function getCronScheduleStatusLabel(
  schedule: string,
  validateSchedule: (schedule: string) => boolean
): { kind: 'empty' | 'invalid' | 'valid'; label: string } {
  const trimmed = schedule.trim()
  if (!trimmed) {
    return { kind: 'empty', label: 'Choose a quick start or enter a five-field cron.' }
  }
  if (!validateSchedule(trimmed)) {
    return { kind: 'invalid', label: 'Enter a valid five-field cron before saving.' }
  }
  const formatted = formatAutomationSchedule(trimmed)
  return { kind: 'valid', label: formatted === 'Custom schedule' ? 'Valid custom cron' : formatted }
}

export function getCronFieldValues(schedule: string): readonly string[] {
  const parts = schedule.trim().split(/\s+/).filter(Boolean)
  return AUTOMATION_CRON_FIELD_LABELS.map((_, index) => parts[index] ?? '...')
}

export function AutomationCustomCronPanel({
  draft,
  customScheduleInvalid,
  validateAdvancedSchedule,
  onUseSimpleSchedule,
  onDraftChange
}: {
  draft: AutomationDraft
  customScheduleInvalid: boolean
  validateAdvancedSchedule: (schedule: string) => boolean
  onUseSimpleSchedule: () => void
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const customScheduleStatus = getCronScheduleStatusLabel(
    draft.customSchedule,
    validateAdvancedSchedule
  )
  const cronFieldValues = getCronFieldValues(draft.customSchedule)

  return (
    <div className="grid gap-3">
      <div className="rounded-md border border-border/70 bg-muted/25 p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-medium">Quick starts</div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
            onClick={onUseSimpleSchedule}
          >
            <RotateCcw className="size-3.5" />
            Simple
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {AUTOMATION_CRON_QUICK_STARTS.map((preset) => (
            <Button
              key={preset.expression}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto min-h-11 flex-col items-start gap-0.5 px-2 py-1.5 text-left"
              onClick={() =>
                onDraftChange((current) => ({
                  ...current,
                  customSchedule: preset.expression,
                  scheduleWarning: null
                }))
              }
            >
              <span className="text-xs font-medium">{preset.label}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {preset.expression}
              </span>
            </Button>
          ))}
        </div>
      </div>
      <Field label="Cron expression">
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
          {AUTOMATION_CRON_FIELD_LABELS.map((label, index) => (
            <div
              key={label}
              className="min-w-0 rounded-md border border-border/70 bg-muted/25 px-1.5 py-1 text-center"
            >
              <div className="truncate text-[10px] font-medium text-muted-foreground">{label}</div>
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
