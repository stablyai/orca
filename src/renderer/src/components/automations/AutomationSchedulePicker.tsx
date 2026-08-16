import React from 'react'
import { CalendarClock, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AutomationSchedulePreset } from '../../../../shared/automations-types'
import {
  buildAutomationCronSchedule,
  buildAutomationRrule,
  formatAutomationSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedules'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationCustomCronPanel } from './AutomationCustomCronPanel'
import { AutomationTimeField, parseAutomationTime } from './AutomationTimeField'
import { Field } from './automation-page-parts'
import { translate } from '@/i18n/i18n'

const FIELD_CONTROL_CLASS = 'border-input bg-input/30 shadow-xs dark:bg-input/30'

export const AUTOMATION_SCHEDULE_PRESET_OPTIONS = [
  ['hourly', 'Hourly', 'auto.components.automations.AutomationSchedulePicker.55b2ef82a4'],
  ['daily', 'Daily', 'auto.components.automations.AutomationSchedulePicker.f0202f3a89'],
  ['weekdays', 'Weekdays', 'auto.components.automations.AutomationSchedulePicker.57e83307d0'],
  ['weekly', 'Weekly', 'auto.components.automations.AutomationSchedulePicker.837d902bba'],
  ['custom', 'Custom cron', 'auto.components.automations.AutomationSchedulePicker.ddba78647e']
] as const satisfies readonly (readonly [AutomationSchedulePreset, string, string])[]

export function getAutomationSchedulePresetLabel([, fallbackLabel, labelKey]: readonly [
  AutomationSchedulePreset,
  string,
  string
]): string {
  return translate(labelKey, fallbackLabel)
}

const DAY_OPTIONS = [
  ['0', 'Sunday'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday']
] as const

function getDraftScheduleLabel(draft: AutomationDraft): string {
  if (draft.preset === 'custom') {
    return draft.customSchedule.trim()
      ? formatAutomationSchedule(draft.customSchedule)
      : 'Advanced schedule'
  }
  const { hour, minute } = parseAutomationTime(draft.time)
  return formatAutomationSchedule(
    buildAutomationRrule({
      preset: draft.preset,
      hour,
      minute,
      dayOfWeek: Number(draft.dayOfWeek)
    })
  )
}

function buildCustomScheduleSeed(draft: AutomationDraft): string {
  const existing = draft.customSchedule.trim()
  if (existing) {
    return draft.customSchedule
  }
  if (draft.preset === 'custom') {
    return ''
  }
  const { hour, minute } = parseAutomationTime(draft.time)
  return buildAutomationCronSchedule({
    preset: draft.preset,
    hour,
    minute,
    dayOfWeek: Number(draft.dayOfWeek)
  })
}

export function getSchedulePresetDraft(
  current: AutomationDraft,
  preset: AutomationSchedulePreset
): Pick<AutomationDraft, 'preset' | 'customSchedule' | 'scheduleWarning'> {
  return {
    preset,
    customSchedule: preset === 'custom' ? buildCustomScheduleSeed(current) : current.customSchedule,
    scheduleWarning: null
  }
}

export function AutomationSchedulePicker({
  draft,
  triggerClassName,
  validateAdvancedSchedule = isValidAutomationSchedule,
  onDraftChange
}: {
  draft: AutomationDraft
  triggerClassName?: string
  validateAdvancedSchedule?: (schedule: string) => boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label = getDraftScheduleLabel(draft)
  const customSchedule = draft.customSchedule.trim()
  const customScheduleInvalid =
    draft.preset === 'custom' &&
    customSchedule.length > 0 &&
    !validateAdvancedSchedule(customSchedule)

  const setTime = (time: string): void => {
    onDraftChange((current) => ({
      ...current,
      time,
      scheduleWarning: null
    }))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-9 w-full justify-between px-3 text-sm font-normal', triggerClassName)}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="popover-scroll-content scrollbar-sleek max-h-[var(--radix-popover-content-available-height)] w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] min-w-[min(22rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
      >
        <div className="grid gap-3">
          <Field
            label={translate(
              'auto.components.automations.AutomationSchedulePicker.233b8c94b6',
              'Cadence'
            )}
          >
            <Select
              value={draft.preset}
              onValueChange={(preset) =>
                onDraftChange((current) => ({
                  ...current,
                  ...getSchedulePresetDraft(current, preset as AutomationSchedulePreset)
                }))
              }
            >
              <SelectTrigger className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {AUTOMATION_SCHEDULE_PRESET_OPTIONS.map(([value, fallbackLabel, labelKey]) => (
                  <SelectItem key={value} value={value}>
                    {getAutomationSchedulePresetLabel([value, fallbackLabel, labelKey])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.preset === 'custom' ? (
            <AutomationCustomCronPanel
              draft={draft}
              customScheduleInvalid={customScheduleInvalid}
              validateAdvancedSchedule={validateAdvancedSchedule}
              onDraftChange={onDraftChange}
            />
          ) : (
            <>
              {draft.preset === 'weekly' ? (
                <Field
                  label={translate(
                    'auto.components.automations.AutomationSchedulePicker.6b914c5fbb',
                    'Day'
                  )}
                >
                  <Select
                    value={draft.dayOfWeek}
                    onValueChange={(dayOfWeek) =>
                      onDraftChange((current) => ({ ...current, dayOfWeek, scheduleWarning: null }))
                    }
                  >
                    <SelectTrigger className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {DAY_OPTIONS.map(([value, dayLabel]) => (
                        <SelectItem key={value} value={value}>
                          {dayLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              {draft.preset === 'hourly' ? (
                <Field
                  label={translate(
                    'auto.components.automations.AutomationSchedulePicker.9e677335b0',
                    'Minute'
                  )}
                >
                  <AutomationTimeField time={draft.time} mode="minute" onTimeChange={setTime} />
                </Field>
              ) : (
                <Field
                  label={translate(
                    'auto.components.automations.AutomationSchedulePicker.d90981f766',
                    'Time'
                  )}
                >
                  <AutomationTimeField time={draft.time} mode="time" onTimeChange={setTime} />
                </Field>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
