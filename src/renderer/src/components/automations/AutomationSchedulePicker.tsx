import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AutomationSchedulePreset } from '../../../../shared/automations-types'
import { buildAutomationCronSchedule } from '../../../../shared/automation-schedule-occurrences'
import { isValidAutomationSchedule } from '../../../../shared/automation-schedule-parsing'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationCustomCronPanel } from './AutomationCustomCronPanel'
import { AutomationTimeField, parseAutomationTime } from './AutomationTimeField'
import { Field } from './automation-page-parts'
import { translate } from '@/i18n/i18n'
import { getUiWeekdayNames } from '@/i18n/weekday-names'

const FIELD_CONTROL_CLASS = 'border-input bg-input/30 shadow-xs dark:bg-input/30'
const AUTOMATION_WEEKDAY_VALUES = ['0', '1', '2', '3', '4', '5', '6'] as const

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
  validateAdvancedSchedule = isValidAutomationSchedule,
  onDraftChange
}: {
  draft: AutomationDraft
  validateAdvancedSchedule?: (schedule: string) => boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const customSchedule = draft.customSchedule.trim()
  const weekdayNames = getUiWeekdayNames()
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
    <div className="grid gap-3">
      <Select
        value={draft.preset}
        onValueChange={(preset) =>
          onDraftChange((current) => ({
            ...current,
            ...getSchedulePresetDraft(current, preset as AutomationSchedulePreset)
          }))
        }
      >
        <SelectTrigger
          aria-label={translate(
            'auto.components.automations.AutomationSchedulePicker.233b8c94b6',
            'Cadence'
          )}
          className={cn('w-full min-w-0', FIELD_CONTROL_CLASS)}
        >
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
                  {AUTOMATION_WEEKDAY_VALUES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {weekdayNames[Number(value)]}
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
  )
}
