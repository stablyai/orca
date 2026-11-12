import { CommandItem } from '@/components/ui/command'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { TEXT_ACTION_DEFAULT_MODEL } from '../../../../shared/agent-launch/picker/agent-launch-picker-text-action'
import type { AgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'

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
  const t = useTranslate()
  if (!entry.textGeneration) {
    return null
  }
  return (
    <>
      {entry.textGeneration.defaultLabel !== undefined ? (
        <CommandItem
          value={TEXT_ACTION_DEFAULT_MODEL}
          disabled={disabled}
          onSelect={() => onSelect({ kind: 'choice', patch: { model: TEXT_ACTION_DEFAULT_MODEL } })}
        >
          {entry.textGeneration.defaultLabel}
        </CommandItem>
      ) : null}
      {modelInArguments ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('agentPicker.setByArguments', 'Set by your Arguments')}
        </div>
      ) : null}
    </>
  )
}
