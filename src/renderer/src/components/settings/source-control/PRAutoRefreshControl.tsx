import { useId } from 'react'
import { Info } from 'lucide-react'
import type { PRAutoRefreshCadence } from '../../../../../shared/review-refresh-policy'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import {
  getPRAutoRefreshCadenceHint,
  getPRAutoRefreshCadenceLabel,
  getPRAutoRefreshDescription,
  getPRAutoRefreshTitle,
  PR_AUTO_REFRESH_KEYWORDS
} from './pr-auto-refresh-search'

export type PRAutoRefreshControlProps = {
  cadence: PRAutoRefreshCadence | null
  onChange: (cadence: PRAutoRefreshCadence) => void
  remoteHostName: string | null
  unsupported?: boolean
  disabled?: boolean
}

export function PRAutoRefreshControl({
  cadence,
  onChange,
  remoteHostName,
  unsupported = false,
  disabled = false
}: PRAutoRefreshControlProps): React.JSX.Element {
  const t = useTranslate()
  const title = getPRAutoRefreshTitle(t)
  const description = getPRAutoRefreshDescription(t)
  const hintId = useId()
  const unavailable = disabled || unsupported || cadence === null
  // Keep saved Minimal cadence intact; it belongs to the Less often choice.
  const selected = unsupported ? 'default' : cadence === 'minimal' ? 'reduced' : cadence
  const hint = selected === null ? null : getPRAutoRefreshCadenceHint(selected, t)
  const disabledReason = unsupported
    ? t(
        'auto.components.settings.GitPane.prAutoRefreshUnsupportedHost',
        'Update Orca on {{host}} to change this',
        {
          host:
            remoteHostName ??
            t('auto.components.settings.GitPane.prAutoRefreshUnknownHost', 'the selected server')
        }
      )
    : undefined
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={PR_AUTO_REFRESH_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        className="max-sm:flex-col max-sm:items-start"
        label={
          <>
            {title}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t(
                    'auto.components.settings.GitPane.prAutoRefreshAbout',
                    'About PR Updates'
                  )}
                  className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {description}
              </TooltipContent>
            </Tooltip>
          </>
        }
        description={
          <span id={hintId} aria-live="polite" className="block min-h-4">
            {hint}
          </span>
        }
        control={
          <SettingsSegmentedControl<PRAutoRefreshCadence | ''>
            value={selected ?? ''}
            onChange={(next) => {
              if (!unavailable && next && next !== selected) {
                onChange(next)
              }
            }}
            ariaLabel={title}
            ariaDescribedBy={hint ? hintId : undefined}
            size="sm"
            options={(['default', 'reduced', 'off'] as const).map((value) => ({
              value,
              label: getPRAutoRefreshCadenceLabel(value, t),
              disabled: unavailable,
              tooltip: disabledReason
            }))}
          />
        }
      />
    </SearchableSetting>
  )
}
