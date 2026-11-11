import { useId } from 'react'
import {
  PR_AUTO_REFRESH_CADENCES,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import {
  getPRAutoRefreshCadenceHint,
  getPRAutoRefreshCadenceLabel,
  getPRAutoRefreshDescription,
  getPRAutoRefreshHostNote,
  getPRAutoRefreshTitle,
  PR_AUTO_REFRESH_KEYWORDS
} from './pr-auto-refresh-search'

export type PRAutoRefreshControlProps = {
  /** null while a remote host has not answered yet. */
  cadence: PRAutoRefreshCadence | null
  onChange: (cadence: PRAutoRefreshCadence) => void
  /** The paired host whose timers this changes; null when it is this device. */
  remoteHostName: string | null
  disabled?: boolean
}

/** Presentational half of the setting: the segmented control plus the two lines that tell the user
 *  what the choice does (actual cadence) and whose behaviour it changes (host scope). */
export function PRAutoRefreshControl({
  cadence,
  onChange,
  remoteHostName,
  disabled = false
}: PRAutoRefreshControlProps): React.JSX.Element {
  const t = useTranslate()
  const title = getPRAutoRefreshTitle(t)
  const description = getPRAutoRefreshDescription(t)
  const hintId = useId()
  const hostNoteId = useId()
  const unavailable = disabled || cadence === null
  const hint =
    cadence === null
      ? remoteHostName
        ? t(
            'auto.components.settings.GitPane.prAutoRefreshReading',
            'Reading the current setting from {{host}}…',
            { host: remoteHostName }
          )
        : null
      : getPRAutoRefreshCadenceHint(cadence, t)
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={PR_AUTO_REFRESH_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <div className="flex max-w-[24rem] flex-col items-end gap-1.5 text-right">
            <SettingsSegmentedControl<PRAutoRefreshCadence>
              value={cadence ?? 'default'}
              onChange={(next) => {
                if (cadence !== null && next !== cadence) {
                  onChange(next)
                }
              }}
              ariaLabel={title}
              ariaDescribedBy={cn(hint && hintId, remoteHostName && hostNoteId) || undefined}
              size="sm"
              options={PR_AUTO_REFRESH_CADENCES.map((value) => ({
                value,
                label: getPRAutoRefreshCadenceLabel(value, t),
                disabled: unavailable
              }))}
            />
            {hint ? (
              <p
                id={hintId}
                aria-live="polite"
                className="select-text text-balance text-xs text-muted-foreground"
                data-testid="pr-auto-refresh-hint"
              >
                {hint}
              </p>
            ) : null}
            {remoteHostName ? (
              <p
                id={hostNoteId}
                className="select-text text-balance text-xs text-foreground/80"
                data-testid="pr-auto-refresh-host-note"
              >
                {getPRAutoRefreshHostNote(remoteHostName, t)}
              </p>
            ) : null}
          </div>
        }
      />
    </SearchableSetting>
  )
}
