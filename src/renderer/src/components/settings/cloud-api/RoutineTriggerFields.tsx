import { useId, useMemo } from 'react'
import { CalendarClock, Github, Webhook } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  AUTOMATION_SCHEDULE_PRESET_OPTIONS,
  getAutomationSchedulePresetLabel
} from '@/components/automations/AutomationSchedulePicker'
import { AutomationTimeField } from '@/components/automations/AutomationTimeField'
import {
  getAutomationCronFieldLabels,
  getCronFieldValues,
  getCronScheduleStatusLabel
} from '@/components/automations/AutomationCustomCronPanel'
import { formatUiAutomationSchedule } from '@/components/automations/automation-schedule-label'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { getUiWeekdayNames } from '@/i18n/weekday-names'
import { cn } from '@/lib/utils'
import { isValidAutomationCronSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import { ROUTINE_GITHUB_EVENTS } from '../../../../../shared/cloud-api/cloud-api-types'
import {
  friendlyTimeZone,
  githubEventLabel,
  shortTimeZoneName,
  timeZoneOptions
} from './cloud-api-format'
import { FormField } from './cloud-api-parts'
import {
  isRoutineSchedulePreset,
  routineDraftCron,
  type RoutineDraft,
  type RoutineTriggerKind
} from './routine-draft'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

type Update = (patch: Partial<RoutineDraft>) => void

export function RoutineScheduleFields({
  draft,
  update,
  cronError
}: {
  draft: RoutineDraft
  update: Update
  cronError: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const ids = useId()
  const weekdays = getUiWeekdayNames(locale)
  const zones = useMemo(() => timeZoneOptions(), [])
  const cron = routineDraftCron(draft)
  const status = getCronScheduleStatusLabel(
    draft.customCron,
    isValidAutomationCronSchedule,
    t,
    locale
  )
  const cronLabels = getAutomationCronFieldLabels(t)
  const cronValues = getCronFieldValues(draft.customCron)

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          id={`${ids}-cadence`}
          label={t('auto.components.settings.cloudRoutines.editor.cadence', 'Repeats')}
        >
          <Select
            value={draft.schedulePreset}
            onValueChange={(preset) => {
              if (!isRoutineSchedulePreset(preset)) {
                return
              }
              update({
                schedulePreset: preset,
                // Seed custom cron from the preset so switching never starts from a blank field.
                ...(preset === 'custom' && !draft.customCron.trim() ? { customCron: cron } : {})
              })
            }}
          >
            <SelectTrigger id={`${ids}-cadence`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {AUTOMATION_SCHEDULE_PRESET_OPTIONS.map((option) => (
                <SelectItem key={option[0]} value={option[0]}>
                  {getAutomationSchedulePresetLabel(option, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          id={`${ids}-tz`}
          label={t('auto.components.settings.cloudRoutines.editor.timezone', 'Time zone')}
        >
          {/* Same Select as Repeats (type-ahead jumps through the zone list). */}
          <Select value={draft.timezone} onValueChange={(timezone) => update({ timezone })}>
            <SelectTrigger id={`${ids}-tz`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-72">
              {zones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {friendlyTimeZone(zone)}
                  <span className="ml-1.5 text-muted-foreground">
                    ({shortTimeZoneName(zone, locale)})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>

      {draft.schedulePreset === 'custom' ? (
        <FormField
          id={`${ids}-cron`}
          label={t('auto.components.settings.cloudRoutines.editor.cron', 'Cron expression')}
          error={cronError}
        >
          <Input
            id={`${ids}-cron`}
            value={draft.customCron}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            variant="code"
            aria-invalid={Boolean(cronError)}
            aria-describedby={`${ids}-cron-status`}
            onChange={(event) => update({ customCron: event.target.value })}
          />
          <div className="grid grid-cols-5 gap-1.5" aria-hidden>
            {cronLabels.map((label, index) => (
              <div
                key={label}
                className="min-w-0 rounded-md border border-border/70 bg-muted/25 px-1.5 py-1 text-center"
              >
                <div className="truncate text-[10px] font-medium text-muted-foreground">
                  {label}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px]">{cronValues[index]}</div>
              </div>
            ))}
          </div>
          <p
            id={`${ids}-cron-status`}
            aria-live="polite"
            className={cn(
              'text-xs',
              status.kind === 'invalid' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {status.label}
          </p>
        </FormField>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {draft.schedulePreset === 'weekly' ? (
            <FormField
              id={`${ids}-day`}
              label={t('auto.components.settings.cloudRoutines.editor.day', 'Day')}
            >
              <Select
                value={String(draft.dayOfWeek)}
                onValueChange={(value) => update({ dayOfWeek: Number(value) })}
              >
                <SelectTrigger id={`${ids}-day`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {weekdays.map((name, index) => (
                    <SelectItem key={name} value={String(index)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : null}
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium">
              {draft.schedulePreset === 'hourly'
                ? t('auto.components.settings.cloudRoutines.editor.minute', 'Minute past the hour')
                : t('auto.components.settings.cloudRoutines.editor.time', 'Time')}
            </p>
            <AutomationTimeField
              time={draft.time}
              mode={draft.schedulePreset === 'hourly' ? 'minute' : 'time'}
              onTimeChange={(time) => update({ time })}
              // Outline like every other field here (the automations shell is filled).
              className="bg-transparent"
            />
          </div>
        </div>
      )}
      {draft.schedulePreset !== 'custom' ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t(
            'auto.components.settings.cloudRoutines.editor.schedulePreview',
            'Schedule: {{schedule}} {{zone}}',
            {
              schedule: formatUiAutomationSchedule(cron, t, locale),
              zone: shortTimeZoneName(draft.timezone, locale)
            }
          )}
        </p>
      ) : null}
    </div>
  )
}

export function RoutineGithubFields({
  draft,
  update,
  eventsError
}: {
  draft: RoutineDraft
  update: Update
  eventsError: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const toggle = (event: (typeof ROUTINE_GITHUB_EVENTS)[number], on: boolean): void => {
    const next = new Set(draft.githubEvents)
    if (on) {
      next.add(event)
    } else {
      next.delete(event)
    }
    update({ githubEvents: ROUTINE_GITHUB_EVENTS.filter((candidate) => next.has(candidate)) })
  }
  const labelsRelevant = draft.githubEvents.some((event) => event.endsWith('.labeled'))
  return (
    <div className="grid gap-3">
      <fieldset
        aria-invalid={Boolean(eventsError)}
        className="grid gap-1.5"
        aria-describedby={eventsError ? `${ids}-events-error` : undefined}
      >
        <legend className="mb-1.5 text-xs font-medium">
          {t('auto.components.settings.cloudRoutines.editor.events', 'Run when')}
        </legend>
        <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {ROUTINE_GITHUB_EVENTS.map((event, index) => (
            <label
              key={event}
              htmlFor={`${ids}-${event}`}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <Checkbox
                id={`${ids}-${event}`}
                // The first box carries the group's error so focus-first-invalid lands here.
                aria-invalid={index === 0 && Boolean(eventsError)}
                checked={draft.githubEvents.includes(event)}
                onCheckedChange={(checked) => toggle(event, checked === true)}
              />
              {githubEventLabel(event, t)}
            </label>
          ))}
        </div>
        {eventsError ? (
          <p id={`${ids}-events-error`} className="text-xs text-destructive">
            {eventsError}
          </p>
        ) : null}
      </fieldset>
      <FormField
        id={`${ids}-labels`}
        label={t('auto.components.settings.cloudRoutines.editor.labels', 'Only with labels')}
        hint={
          labelsRelevant
            ? t(
                'auto.components.settings.cloudRoutines.editor.labelsHint',
                'Comma-separated. Leave empty for any label.'
              )
            : t(
                'auto.components.settings.cloudRoutines.editor.labelsHintOther',
                'Comma-separated. Matches labels already on the PR or issue.'
              )
        }
      >
        <Input
          id={`${ids}-labels`}
          value={draft.labels}
          placeholder={t(
            'auto.components.settings.cloudRoutines.editor.labelsPlaceholder',
            'orca, needs-review'
          )}
          onChange={(event) => update({ labels: event.target.value })}
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          id={`${ids}-authors`}
          label={t('auto.components.settings.cloudRoutines.editor.authors', 'Only from authors')}
          hint={t(
            'auto.components.settings.cloudRoutines.editor.anyone',
            'Leave empty for anyone.'
          )}
        >
          <Input
            id={`${ids}-authors`}
            value={draft.authors}
            placeholder={t(
              'auto.components.settings.cloudRoutines.editor.authorsPlaceholder',
              'octocat, dependabot[bot]'
            )}
            onChange={(event) => update({ authors: event.target.value })}
          />
        </FormField>
        <FormField
          id={`${ids}-branches`}
          label={t('auto.components.settings.cloudRoutines.editor.branches', 'Only into branches')}
          hint={t(
            'auto.components.settings.cloudRoutines.editor.anyBranch',
            'Leave empty for any branch.'
          )}
        >
          <Input
            id={`${ids}-branches`}
            value={draft.baseBranches}
            placeholder={t(
              'auto.components.settings.cloudRoutines.editor.branchesPlaceholder',
              'main'
            )}
            onChange={(event) => update({ baseBranches: event.target.value })}
          />
        </FormField>
      </div>
    </div>
  )
}

export function RoutineTriggerKindControl({
  value,
  onChange,
  labelledBy
}: {
  value: RoutineTriggerKind
  onChange: (kind: RoutineTriggerKind) => void
  labelledBy: string
}): React.JSX.Element {
  const t = useTranslate()
  const options: { value: RoutineTriggerKind; label: React.ReactNode }[] = [
    {
      value: 'schedule',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock className="size-3.5" aria-hidden />
          {t('auto.components.settings.cloudRoutines.trigger.schedule', 'Schedule')}
        </span>
      )
    },
    {
      value: 'github',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <Github className="size-3.5" aria-hidden />
          {t('auto.components.settings.cloudRoutines.trigger.github', 'GitHub event')}
        </span>
      )
    },
    {
      value: 'webhook',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <Webhook className="size-3.5" aria-hidden />
          {t('auto.components.settings.cloudRoutines.trigger.webhook', 'Webhook')}
        </span>
      )
    }
  ]
  return (
    <SettingsSegmentedControl<RoutineTriggerKind>
      value={value}
      onChange={onChange}
      ariaLabelledBy={labelledBy}
      size="sm"
      equalWidth
      options={options}
    />
  )
}
