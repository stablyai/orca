import type React from 'react'
import { useId } from 'react'
import { useAppStore } from '../../../store/index'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { getOrcaCloudTeamCapabilities } from '../../../../../shared/orca-profiles/orca-cloud-team-policy'
import {
  normalizeUpdateDelayDays,
  UPDATE_DELAY_DAY_OPTIONS
} from '../../../../../shared/updater/update-delay'
import { getUpdateDelayDescription, getUpdateDelayTitle } from './update-delay-copy'

// Intl formatter caches key on option identity, so this must be a module constant.
const DAY_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'day',
  unitDisplay: 'long'
}

function formatDelayDays(days: number, t: Translate = translate, intlLocale?: string): string {
  if (days === 0) {
    return t('settings.updateDelay.none', 'None')
  }
  // Intl pluralizes and localizes "1 day" / "7 days" without per-locale catalog entries.
  return uiNumberFormat(DAY_UNIT_FORMAT, intlLocale).format(days)
}

// Re-check so the status row reflects the new delay without waiting a day.
function canRecheckAfterDelayChange(status: UpdateStatus): boolean {
  return (
    status.state === 'idle' ||
    status.state === 'checking' ||
    status.state === 'not-available' ||
    status.state === 'available' ||
    status.state === 'error'
  )
}

export function UpdateDelaySetting(): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const delayDays = useAppStore((s) => normalizeUpdateDelayDays(s.settings?.updateDelayDays))
  const teamDelayDays = useAppStore(
    (s) => getOrcaCloudTeamCapabilities(s.orcaProfileAuthStatus)?.teamPolicy?.updateDelayDays
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const labelId = useId()
  const descriptionId = useId()
  const title = getUpdateDelayTitle(t)
  const description = getUpdateDelayDescription(t)
  const options = UPDATE_DELAY_DAY_OPTIONS.includes(delayDays)
    ? UPDATE_DELAY_DAY_OPTIONS
    : [...UPDATE_DELAY_DAY_OPTIONS, delayDays].sort((a, b) => a - b)

  const setDelayDays = (next: number): void => {
    if (next === delayDays) {
      return
    }
    const shouldRecheck = canRecheckAfterDelayChange(updateStatus)
    void updateSettings({ updateDelayDays: next }).then(() => {
      if (shouldRecheck) {
        void window.api.updater.check({ ignoreUpdateDelay: false })
      }
    })
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'update',
        'delay',
        'cooldown',
        'defer',
        'wait',
        'stable',
        'security',
        'supply chain'
      ]}
    >
      <SettingsRow
        label={title}
        labelId={labelId}
        control={
          teamDelayDays === undefined ? (
            <Select
              value={String(delayDays)}
              onValueChange={(value) => setDelayDays(Number(value))}
            >
              <SelectTrigger size="sm" aria-labelledby={labelId} aria-describedby={descriptionId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {formatDelayDays(days, t, intlLocale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t('settings.updateDelay.teamManaged', 'Set by your team')}
              {' · '}
              {formatDelayDays(teamDelayDays, t, intlLocale)}
            </span>
          )
        }
      />
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </SearchableSetting>
  )
}
