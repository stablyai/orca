import { cn } from '@/lib/class-names'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AutomationSchedulePreset } from '../../../../../shared/automations/automation-definition'
import { buildAutomationCronSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-occurrences'
import { isValidAutomationSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationCustomCronPanel } from './AutomationCustomCronPanel'
import { acceptsAutomationDraftSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-input-gate'
import { AutomationTimeField, parseAutomationTime } from './AutomationTimeField'
import { Field } from '../automation-page-parts'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
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

export function getAutomationSchedulePresetLabel(
  [, fallbackLabel, labelKey]: readonly [AutomationSchedulePreset, string, string],
  t: Translate = translate
): string {
  return t(labelKey, fallbackLabel)
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

// A bot's When menu: no schedule (when it has events), or set up events in its chat.
const NO_SCHEDULE = 'none'
const ON_EVENTS = 'events'

export function AutomationSchedulePicker({
  draft,
  validateAdvancedSchedule = isValidAutomationSchedule,
  onDraftChange,
  onSetUpEvents
}: {
  draft: AutomationDraft
  validateAdvancedSchedule?: (schedule: string) => boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  /** Present for a bot: its events are set up by chatting with it. */
  onSetUpEvents?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const customSchedule = draft.customSchedule.trim()
  const hasEvents = Boolean(draft.savedBotAutomation?.on.length)
  const weekdayNames = getUiWeekdayNames(intlLocale)
  // Match save validation: an untouched legacy cadence is not new input and must not show a strict-validation error.
  const acceptsSchedule = (schedule: string): boolean =>
    acceptsAutomationDraftSchedule({
      customSchedule: schedule,
      savedRrule: draft.savedSchedule,
      validate: validateAdvancedSchedule
    })
  const customScheduleInvalid =
    draft.preset === 'custom' && customSchedule.length > 0 && !acceptsSchedule(customSchedule)

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
        value={draft.eventsOnly ? NO_SCHEDULE : draft.preset}
        onValueChange={(value) => {
          if (value === ON_EVENTS) {
            onSetUpEvents?.()
            return
          }
          const preset = AUTOMATION_SCHEDULE_PRESET_OPTIONS.find(
            ([option]) => option === value
          )?.[0]
          onDraftChange((current) =>
            preset
              ? { ...current, eventsOnly: false, ...getSchedulePresetDraft(current, preset) }
              : { ...current, eventsOnly: true, scheduleWarning: null }
          )
        }}
      >
        <SelectTrigger
          aria-label={t(
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
              {getAutomationSchedulePresetLabel([value, fallbackLabel, labelKey], t)}
            </SelectItem>
          ))}
          {/* Saved without a schedule and with every event removed, it runs on nothing. */}
          {hasEvents || draft.eventsOnly ? (
            <SelectItem value={NO_SCHEDULE}>
              {hasEvents
                ? t('automations.botTarget.noSchedule', 'Only on events')
                : t('automations.botTarget.never', 'Never')}
            </SelectItem>
          ) : null}
          {onSetUpEvents ? (
            <SelectItem value={ON_EVENTS}>
              {t('automations.botTarget.onEvents', 'When something happens…')}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {draft.eventsOnly ? null : draft.preset === 'custom' ? (
        <AutomationCustomCronPanel
          draft={draft}
          customScheduleInvalid={customScheduleInvalid}
          validateAdvancedSchedule={acceptsSchedule}
          onDraftChange={onDraftChange}
        />
      ) : (
        <>
          {draft.preset === 'weekly' ? (
            <Field
              label={t('auto.components.automations.AutomationSchedulePicker.6b914c5fbb', 'Day')}
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
              label={t('auto.components.automations.AutomationSchedulePicker.9e677335b0', 'Minute')}
            >
              <AutomationTimeField time={draft.time} mode="minute" onTimeChange={setTime} />
            </Field>
          ) : (
            <Field
              label={t('auto.components.automations.AutomationSchedulePicker.d90981f766', 'Time')}
            >
              <AutomationTimeField time={draft.time} mode="time" onTimeChange={setTime} />
            </Field>
          )}
        </>
      )}
    </div>
  )
}
