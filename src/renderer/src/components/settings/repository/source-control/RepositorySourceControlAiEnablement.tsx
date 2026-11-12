import type React from 'react'
import type { SourceControlAiSettings } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type RepositorySourceControlAiEnablementProps = {
  value: boolean | undefined
  source: SourceControlAiSettings
  onChange: (value: boolean | undefined) => void
}

function enablementValue(value: boolean | undefined): 'inherit' | 'on' | 'off' {
  if (value === true) {
    return 'on'
  }
  if (value === false) {
    return 'off'
  }
  return 'inherit'
}

function visibilityLabel(value: boolean, t: Translate = translate): string {
  return value
    ? t('auto.components.settings.RepositorySourceControlAiEnablement.show', 'Show')
    : t('auto.components.settings.RepositorySourceControlAiEnablement.hide', 'Hide')
}

export function RepositorySourceControlAiEnablement({
  value,
  source,
  onChange
}: RepositorySourceControlAiEnablementProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      data-settings-row=""
      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-0.5">
        <Label className="text-xs font-medium">
          {t(
            'auto.components.settings.RepositorySourceControlAiEnablement.showActionsLabel',
            'Show Source Control AI actions'
          )}
        </Label>
        <p className="text-[11px] text-muted-foreground">
          {t(
            'auto.components.settings.RepositorySourceControlAiEnablement.visibilityHelper',
            "Controls whether Source Control AI buttons are shown for this repository. Generation used by separate features follows those features' settings. Global default is {{value0}}.",
            { value0: visibilityLabel(source.enabled, t) }
          )}
        </p>
      </div>
      <Select
        value={enablementValue(value)}
        onValueChange={(nextValue) => {
          onChange(nextValue === 'inherit' ? undefined : nextValue === 'on')
        }}
      >
        <SelectTrigger size="sm" className="h-8 w-full text-xs sm:w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {t(
              'auto.components.settings.RepositorySourceControlAiEnablement.62511a575d',
              'Use global'
            )}
          </SelectItem>
          <SelectItem value="on">
            {t('auto.components.settings.RepositorySourceControlAiEnablement.show', 'Show')}
          </SelectItem>
          <SelectItem value="off">
            {t('auto.components.settings.RepositorySourceControlAiEnablement.hide', 'Hide')}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
