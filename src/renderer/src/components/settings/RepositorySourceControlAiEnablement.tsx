import type React from 'react'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

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

function visibilityLabel(value: boolean): string {
  return value
    ? translate('auto.components.settings.RepositorySourceControlAiEnablement.show', 'Show')
    : translate('auto.components.settings.RepositorySourceControlAiEnablement.hide', 'Hide')
}

export function RepositorySourceControlAiEnablement({
  value,
  source,
  onChange
}: RepositorySourceControlAiEnablementProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-xs font-medium">
          {translate(
            'auto.components.settings.RepositorySourceControlAiEnablement.showActionsLabel',
            'Show Source Control AI actions'
          )}
        </Label>
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.RepositorySourceControlAiEnablement.visibilityHelper',
            "Controls whether Source Control AI buttons are shown for this repository. Generation used by separate features follows those features' settings. Global default is {{value0}}.",
            { value0: visibilityLabel(source.enabled) }
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
            {translate(
              'auto.components.settings.RepositorySourceControlAiEnablement.62511a575d',
              'Use global'
            )}
          </SelectItem>
          <SelectItem value="on">
            {translate('auto.components.settings.RepositorySourceControlAiEnablement.show', 'Show')}
          </SelectItem>
          <SelectItem value="off">
            {translate('auto.components.settings.RepositorySourceControlAiEnablement.hide', 'Hide')}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
