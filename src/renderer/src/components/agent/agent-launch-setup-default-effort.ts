import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import { TEXT_ACTION_DEFAULT_MODEL } from '../../../../shared/agent-launch/picker/agent-launch-picker-text-action'
import type { Translate } from '@/i18n/use-translate'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

/** Every effort carrier except one composed into the model id is its own optional flag or session
 *  value, so omitting it runs the agent's own level. A Settings level would fill the omission. */
function launchEffortDefaultOffered(entry: AgentPickerEntry, draft: AgentPickerDraft): boolean {
  const defaults = draft.surface === 'chat' ? entry.structured : entry.terminal
  if (entry.textGeneration || defaults.options?.effort !== undefined) {
    return false
  }
  return (
    draft.surface === 'chat' ||
    !getAgentSessionOptionLaunchCatalog(entry.agent)?.models.some((model) =>
      model.options.some((option) => option.id === 'effort' && option.apply.composedIntoModel)
    )
  )
}

/** Leads the effort levels with Default, selected once the draft delegates effort to the agent. */
export function withLaunchEffortDefault(
  rows: SessionOptionDescriptor[],
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  t: Translate
): SessionOptionDescriptor[] {
  if (!launchEffortDefaultOffered(entry, draft)) {
    return rows
  }
  return rows.map((row) =>
    row.id !== 'effort' ||
    row.kind.type !== 'select' ||
    !row.kind.choices.length ||
    row.kind.choices.some((choice) => choice.value === 'arguments')
      ? row
      : {
          ...row,
          kind: {
            ...row.kind,
            choices: [
              {
                value: TEXT_ACTION_DEFAULT_MODEL,
                label: t('agentPicker.effortDefault', 'Default')
              },
              ...row.kind.choices
            ],
            currentValue: draft.delegated?.includes('effort')
              ? TEXT_ACTION_DEFAULT_MODEL
              : row.kind.currentValue
          }
        }
  )
}
