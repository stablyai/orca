import React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  if (!applies) {
    return null
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="source-control-agent-cli-args" className="text-xs">
        {t('settings.sourceControl.actionModel.extraArgs', 'Extra CLI arguments')}
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
