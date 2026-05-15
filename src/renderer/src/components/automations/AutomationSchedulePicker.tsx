import React from 'react'
import { CalendarClock, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  formatAutomationSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedules'
import type { AutomationDraft } from './AutomationEditorDialog'
import { Field } from './automation-page-parts'

const DAY_OPTIONS = [
  ['0', 'Sunday'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday']
] as const

function parseTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map((part) => Number(part))
  return {
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0
  }
}

function getDraftScheduleLabel(draft: AutomationDraft): string {
  if (draft.preset === 'custom') {
    return draft.customSchedule.trim()
      ? formatAutomationSchedule(draft.customSchedule)
      : 'Custom cron'
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

export function AutomationSchedulePicker({
  draft,
  onDraftChange
}: {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label = getDraftScheduleLabel(draft)
  const customSchedule = draft.customSchedule.trim()
  const customScheduleInvalid =
    draft.preset === 'custom' &&
    customSchedule.length > 0 &&
    !isValidAutomationSchedule(customSchedule)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between px-3 text-sm font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[19rem] p-3"
      >
        <div className="grid gap-3">
          <Field label="Schedule">
            <Select
              value={draft.preset}
              onValueChange={(preset) =>
                onDraftChange((current) => ({
                  ...current,
                  preset: preset as AutomationSchedulePreset,
                  scheduleWarning: null
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">Hourly</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekdays">Weekdays</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="custom">Custom cron</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {draft.preset === 'custom' ? (
            <Field label="Cron string">
              <Input
                value={draft.customSchedule}
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                className="font-mono"
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
                Five fields: minute hour day month weekday.
              </div>
              {customScheduleInvalid ? (
                <div className="mt-1 text-[11px] text-destructive">
                  Enter a valid 5-field cron expression.
                </div>
              ) : null}
            </Field>
          ) : null}
          {draft.preset === 'weekly' ? (
            <Field label="Day">
              <Select
                value={draft.dayOfWeek}
                onValueChange={(dayOfWeek) =>
                  onDraftChange((current) => ({ ...current, dayOfWeek, scheduleWarning: null }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {draft.preset !== 'custom' ? (
            <Field label={draft.preset === 'hourly' ? 'Minute' : 'Time'}>
              <Input
                type="time"
                value={draft.time}
                onChange={(event) =>
                  onDraftChange((current) => ({
                    ...current,
                    time: event.target.value,
                    scheduleWarning: null
                  }))
                }
              />
            </Field>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
