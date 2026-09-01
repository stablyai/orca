import type React from 'react'
import { useMemo, useState } from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { StatusBarUsageFormat } from '../../../../shared/status-bar-usage-format'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  buildUsageFormatValues,
  renderUsageFormatTemplate
} from '../status-bar/usage-format-template'
import { getStatusBarUsageFormatEntry } from './appearance-status-bar-usage-format-search'
import { SettingsRow } from './SettingsFormControls'

type StatusBarUsageFormatSettingProps = {
  format: StatusBarUsageFormat
  onChange: (format: StatusBarUsageFormat) => void
}

const EXAMPLE_TEMPLATE =
  '{provider}[ | 5h: {5h} ({5h.reset})][ | 7d: {7d}][ | Fable: {fable}][ | 30d: {30d}]'

const PLACEHOLDERS: readonly [token: string, fallback: string, key: string][] = [
  ['{provider}', 'provider name', 'provider'],
  ['{plan}', 'plan (Codex)', 'plan'],
  ['{5h} {7d} {fable} {30d}', 'window percentage', 'windows'],
  ['{5h.reset}', 'time until reset, e.g. 3h 15m', 'reset'],
  ['{5h.resetAt}', 'reset clock time, e.g. 20:50', 'resetAt'],
  ['{buckets}', 'Gemini model buckets', 'buckets'],
  ['[ … ]', 'dropped when a placeholder inside is empty', 'optional']
]

/** Fixed sample so the preview reads meaningfully before any provider has reported usage. */
function sampleLimits(now: number): ProviderRateLimits {
  const hours = 60 * 60 * 1000
  return {
    provider: 'claude',
    session: {
      usedPercent: 14,
      windowMinutes: 300,
      resetsAt: now + 3.25 * hours,
      resetDescription: null
    },
    weekly: {
      usedPercent: 20,
      windowMinutes: 10080,
      resetsAt: now + 63 * hours,
      resetDescription: null
    },
    fableWeekly: {
      usedPercent: 37,
      windowMinutes: 10080,
      resetsAt: now + 63 * hours,
      resetDescription: null
    },
    updatedAt: now,
    error: null,
    status: 'ok'
  }
}

/** Template editor for the footer usage text, with a live preview rendered against sample limits. */
export function StatusBarUsageFormatSetting({
  format,
  onChange
}: StatusBarUsageFormatSettingProps): React.JSX.Element {
  const display = normalizeUsagePercentageDisplay(useAppStore((s) => s.usagePercentageDisplay))
  const entry = getStatusBarUsageFormatEntry()
  const template = format.template
  const hasTemplate = template.trim().length > 0
  // Why: the sample's reset times are relative to `now`, so a mount-time clock keeps the preview stable.
  const [now] = useState(() => Date.now())
  const preview = useMemo(() => {
    if (!hasTemplate) {
      return null
    }
    return renderUsageFormatTemplate(
      template,
      buildUsageFormatValues(sampleLimits(now), { display, now })
    )
  }, [display, hasTemplate, now, template])

  return (
    <div className="space-y-2">
      <SettingsRow
        alignTop
        label={entry.title}
        description={entry.description}
        control={
          hasTemplate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...format, template: '' })}
            >
              {translate('auto.components.settings.StatusBarUsageFormatSetting.reset', 'Reset')}
            </Button>
          ) : null
        }
      />
      {/* Why full-width: templates run long, and the row's control slot would truncate them. */}
      <Input
        aria-label={entry.title}
        value={template}
        placeholder={EXAMPLE_TEMPLATE}
        spellCheck={false}
        className="h-8 font-mono text-[12px]"
        onChange={(event) => onChange({ ...format, template: event.target.value })}
      />
      <div className="space-y-1 text-[11px] text-muted-foreground">
        <div>
          <span className="text-foreground/80">
            {translate(
              'auto.components.settings.StatusBarUsageFormatSetting.previewLabel',
              'Preview'
            )}
            {': '}
          </span>
          {preview !== null ? (
            <span className="whitespace-pre font-mono tabular-nums text-foreground">{preview}</span>
          ) : (
            translate(
              'auto.components.settings.StatusBarUsageFormatSetting.previewBuiltin',
              'Leave empty to use Orca’s built-in format.'
            )
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {PLACEHOLDERS.map(([token, fallback, key]) => (
            <div key={key} className="contents">
              <dt className="font-mono">{token}</dt>
              <dd>
                {translate(
                  `auto.components.settings.StatusBarUsageFormatSetting.placeholder.${key}`,
                  fallback
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
