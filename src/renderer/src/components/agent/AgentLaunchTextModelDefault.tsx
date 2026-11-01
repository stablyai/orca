import { CommandItem } from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import {
  TEXT_ACTION_DEFAULT_MODEL,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'
import type { AgentPickerEdit } from '../../../../shared/agent-launch-picker-edits'

export function AgentLaunchTextModelDefault({
  entry,
  disabled,
  modelInArguments,
  onSelect
}: {
  entry: AgentPickerEntry
  disabled?: boolean
  modelInArguments?: boolean
  onSelect: (edit: AgentPickerEdit) => void
}) {
  if (!entry.textGeneration) {
    return null
  }
  return (
    <>
      <CommandItem
        value={TEXT_ACTION_DEFAULT_MODEL}
        disabled={disabled}
        onSelect={() => onSelect({ kind: 'choice', patch: { model: TEXT_ACTION_DEFAULT_MODEL } })}
      >
        {entry.textGeneration.defaultLabel}
      </CommandItem>
      {modelInArguments ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {translate('agentPicker.setByArguments', 'Set by your Arguments')}
        </div>
      ) : null}
    </>
  )
}
