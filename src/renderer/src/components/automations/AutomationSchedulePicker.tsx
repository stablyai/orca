import React from 'react'
import { CalendarClock, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  buildAutomationRrule,
  classifyAutomationCronSchedule,
  formatAutomationSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedules'
import type { AutomationDraft } from './AutomationEditorDialog'
import { Field } from './automation-page-parts'

const FIELD_CONTROL_CLASS = 'border-input bg-input/30 shadow-xs dark:bg-input/30'
type SimpleSchedulePreset = Exclude<AutomationSchedulePreset, 'custom'>

const SIMPLE_PRESETS = [
  ['hourly', 'Hourly'],
  ['daily', 'Daily'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly']
] as const

const DAY_OPTIONS = [
  ['0', 'Sunday'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday']
] as const
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, index) => String(index + 1))
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => String(index))
const PERIOD_OPTIONS = ['AM', 'PM'] as const

function parseTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map((part) => Number(part))
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0
  }
}

function formatTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function getClockParts(time: string): { hour12: number; minute: number; period: 'AM' | 'PM' } {
  const { hour, minute } = parseTime(time)
  return {
    hour12: hour % 12 === 0 ? 12 : hour % 12,
    minute,
    period: hour >= 12 ? 'PM' : 'AM'
  }
}

function updateTimePart(
  time: string,
  patch: { hour12?: number; minute?: number; period?: 'AM' | 'PM' }
): string {
  const current = getClockParts(time)
  const nextHour12 = patch.hour12 ?? current.hour12
  const nextPeriod = patch.period ?? current.period
  const nextMinute = patch.minute ?? current.minute
  const hour24 =
    nextPeriod === 'AM'
      ? nextHour12 === 12
        ? 0
        : nextHour12
      : nextHour12 === 12
        ? 12
        : nextHour12 + 12
  return formatTimeInput(hour24, nextMinute)
}

function getDraftScheduleLabel(draft: AutomationDraft): string {
  if (draft.preset === 'custom') {
    return draft.customSchedule.trim()
      ? formatAutomationSchedule(draft.customSchedule)
      : 'Advanced schedule'
  }
  const { hour, minute } = parseTime(draft.time)
  return formatAutomationSchedule(
    buildAutomationRrule({
      preset: draft.preset,
      hour,
      minute,
      dayOfWeek: Number(draft.dayOfWeek)
    })
  )
}

function getSimpleScheduleDraft(
  current: AutomationDraft
): Pick<AutomationDraft, 'preset' | 'time' | 'dayOfWeek'> {
  const classification = classifyAutomationCronSchedule(current.customSchedule)
  if (classification.kind === 'hourly') {
    const { hour } = parseTime(current.time)
    return {
      preset: 'hourly',
      time: formatTimeInput(hour, classification.minute),
      dayOfWeek: current.dayOfWeek
    }
  }
  if (classification.kind === 'daily' || classification.kind === 'weekdays') {
    return {
      preset: classification.kind,
      time: formatTimeInput(classification.hour, classification.minute),
      dayOfWeek: current.dayOfWeek
    }
  }
  if (classification.kind === 'weekly') {
    return {
      preset: 'weekly',
      time: formatTimeInput(classification.hour, classification.minute),
      dayOfWeek: String(classification.dayOfWeek)
    }
  }
  return { preset: 'weekdays', time: current.time, dayOfWeek: current.dayOfWeek || '1' }
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
  const clockParts = getClockParts(draft.time)
  const customSchedule = draft.customSchedule.trim()
  const customScheduleInvalid =
    draft.preset === 'custom' &&
    customSchedule.length > 0 &&
    !validateAdvancedSchedule(customSchedule)

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
        className="w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] min-w-[min(18rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-3"
      >
        <div className="grid gap-3">
          {draft.preset === 'custom' ? (
            <div className="grid gap-3">
              <Field label="Advanced schedule">
                <Input
                  value={draft.customSchedule}
                  placeholder="0 9 * * 1-5"
                  spellCheck={false}
                  className={cn('font-mono', FIELD_CONTROL_CLASS)}
                  aria-invalid={customScheduleInvalid}
                  onChange={(event) =>
                    onDraftChange((current) => ({
                      ...current,
                      customSchedule: event.target.value,
                      scheduleWarning: null
                    }))
                  }
                />
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Existing advanced schedules are preserved until you choose a simple schedule.
                </div>
                {customScheduleInvalid ? (
                  <div className="mt-1 text-[11px] text-destructive">
                    Enter a valid advanced schedule before saving.
                  </div>
                ) : null}
              </Field>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="justify-start"
                onClick={() =>
                  onDraftChange((current) => ({
                    ...current,
                    ...getSimpleScheduleDraft(current),
                    scheduleWarning: null
                  }))
                }
              >
                Use simple schedule
              </Button>
            </div>
          ) : (
            <>
              <Field label="Cadence">
                <Select
                  value={draft.preset}
                  onValueChange={(preset) =>
                    onDraftChange((current) => ({
                      ...current,
                      preset: preset as SimpleSchedulePreset,
                      scheduleWarning: null
                    }))
                  }
                >
                  <SelectTrigger className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SIMPLE_PRESETS.map(([value, presetLabel]) => (
                      <SelectItem key={value} value={value}>
                        {presetLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {draft.preset === 'weekly' ? (
                <Field label="Day">
                  <Select
                    value={draft.dayOfWeek}
                    onValueChange={(dayOfWeek) =>
                      onDraftChange((current) => ({ ...current, dayOfWeek, scheduleWarning: null }))
                    }
                  >
                    <SelectTrigger className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
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
                <Field label="Minute">
                  <Select
                    value={String(clockParts.minute)}
                    onValueChange={(minute) =>
                      onDraftChange((current) => ({
                        ...current,
                        time: updateTimePart(current.time, { minute: Number(minute) }),
                        scheduleWarning: null
                      }))
                    }
                  >
                    <SelectTrigger className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MINUTE_OPTIONS.map((minute) => (
                        <SelectItem key={minute} value={minute}>
                          :{minute.padStart(2, '0')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : (
                <Field label="Time">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)] gap-2">
                    <Select
                      value={String(clockParts.hour12)}
                      onValueChange={(hour12) =>
                        onDraftChange((current) => ({
                          ...current,
                          time: updateTimePart(current.time, { hour12: Number(hour12) }),
                          scheduleWarning: null
                        }))
                      }
                    >
                      <SelectTrigger
                        aria-label="Hour"
                        className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HOUR_OPTIONS.map((hour) => (
                          <SelectItem key={hour} value={hour}>
                            {hour}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={String(clockParts.minute)}
                      onValueChange={(minute) =>
                        onDraftChange((current) => ({
                          ...current,
                          time: updateTimePart(current.time, { minute: Number(minute) }),
                          scheduleWarning: null
                        }))
                      }
                    >
                      <SelectTrigger
                        aria-label="Minute"
                        className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MINUTE_OPTIONS.map((minute) => (
                          <SelectItem key={minute} value={minute}>
                            {minute.padStart(2, '0')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={clockParts.period}
                      onValueChange={(period) =>
                        onDraftChange((current) => ({
                          ...current,
                          time: updateTimePart(current.time, { period: period as 'AM' | 'PM' }),
                          scheduleWarning: null
                        }))
                      }
                    >
                      <SelectTrigger
                        aria-label="AM or PM"
                        className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERIOD_OPTIONS.map((period) => (
                          <SelectItem key={period} value={period}>
                            {period}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </Field>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
