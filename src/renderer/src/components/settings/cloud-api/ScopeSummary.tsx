import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudApiScope } from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsBadge } from '../form-controls/SettingsFormControls'
import { scopeSummaryKind } from './cloud-api-format'

/** "Read only" / "Full access" / "Custom · 5 scopes", with the exact scopes one hover or focus away. */
export function ScopeSummary({ scopes }: { scopes: readonly CloudApiScope[] }): React.JSX.Element {
  const t = useTranslate()
  const kind = scopeSummaryKind(scopes)
  const label =
    kind === 'read'
      ? t('auto.components.settings.cloudApi.create.readOnly', 'Read only')
      : kind === 'full'
        ? t('auto.components.settings.cloudApi.create.full', 'Full access')
        : t(
            'auto.components.settings.cloudApi.keys.customScopeCount',
            'Custom · {{count}} scopes',
            {
              count: scopes.length,
              defaultValue_one: 'Custom · {{count}} scope'
            }
          )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="shrink-0 cursor-default rounded outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          aria-label={t(
            'auto.components.settings.cloudApi.keys.scopesLabel',
            '{{value0}}: {{value1}}',
            { value0: label, value1: scopes.join(', ') }
          )}
        >
          <SettingsBadge tone="muted">{label}</SettingsBadge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="font-mono text-[11px] leading-5">{scopes.join(' · ')}</span>
      </TooltipContent>
    </Tooltip>
  )
}
