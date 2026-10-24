import React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

/**
 * The extra CLI arguments a terminal launch appends; the saved model and permissions apply on
 * either route, so this field carries only what has no control of its own.
 *
 * Renders nothing when the launch would be a structured native chat session: that route drives the
 * agent over a protocol and reads no CLI arguments, so the field is absent rather than disabled.
 */
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
