import React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

/** Native chat uses a protocol and ignores CLI arguments, so omit the field for those launches. */
export function SourceControlAgentCliArgsField({
  applies,
  value,
  onChange
}: {
  applies: boolean
  value: string
  onChange: (value: string) => void
}): React.JSX.Element | null {
  if (!applies) {
    return null
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="source-control-agent-cli-args" className="text-xs">
        {translate('settings.sourceControl.actionModel.extraArgs', 'Extra CLI arguments')}
      </Label>
      <Input
        id="source-control-agent-cli-args"
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 font-mono text-xs"
      />
    </div>
  )
}
