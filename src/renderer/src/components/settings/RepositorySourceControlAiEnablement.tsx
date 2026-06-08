import type React from 'react'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

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

export function RepositorySourceControlAiEnablement({
  value,
  source,
  onChange
}: RepositorySourceControlAiEnablementProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-xs font-medium">Source Control AI enabled</Label>
        <p className="text-[11px] text-muted-foreground">
          Global default is {source.enabled ? 'On' : 'Off'}.
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
          <SelectItem value="inherit">Use global</SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
