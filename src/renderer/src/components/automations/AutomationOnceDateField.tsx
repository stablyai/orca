import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  automationOnceRunAt,
  buildAutomationOnceSchedule
} from '../../../../shared/automation-once-schedule'
import type { AutomationDraft } from './AutomationEditorDialog'
import { Field } from './automation-page-parts'

export function AutomationOnceDateField({
  draft,
  onDraftChange
}: {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const [now] = useState(Date.now)
  const runAt = automationOnceRunAt(draft.onceDate ?? '', draft.time)
  const unchanged =
    draft.savedSchedule !== null &&
    draft.savedSchedule === (runAt === null ? '' : buildAutomationOnceSchedule(runAt))
  const invalid = !unchanged && (runAt === null || runAt <= now)
  const dateLabel = translate('automations.once.date', 'Date')
  return (
    <Field label={dateLabel}>
      <Input
        type="date"
        aria-label={dateLabel}
        aria-invalid={invalid}
        aria-describedby="automation-once-status"
        value={draft.onceDate ?? ''}
        onChange={(event) => {
          const onceDate = event.currentTarget.value
          onDraftChange((current) => ({ ...current, onceDate, scheduleWarning: null }))
        }}
      />
      <p
        id="automation-once-status"
        className="mt-2 text-xs text-muted-foreground"
        role={invalid ? 'alert' : undefined}
      >
        {invalid
          ? translate('automations.once.futureRequired', 'Choose a valid future date and time.')
          : translate(
              'automations.once.description',
              'Runs once, then pauses automatically. Time zone: {{timezone}}.',
              {
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
              }
            )}
      </p>
    </Field>
  )
}
