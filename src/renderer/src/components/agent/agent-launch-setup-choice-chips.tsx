import { AgentArgsChoiceChips } from './launch-settings/AgentArgsChoiceChips'
import { agentModelChoiceChips } from './launch-settings/agent-model-choice-chips'
import { antigravityModelSelection } from '../../../../shared/agent-session/options/antigravity-model-efforts'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch/picker/agent-launch-picker-arguments'
import type {
  AgentPickerEntry,
  AgentPickerDraft,
  AgentPickerModel
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'

export function agentLaunchSetupChoiceChips(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  editDraft: (edit: AgentPickerEdit) => void,
  getDraft: () => AgentPickerDraft | undefined
) {
  const argumentsView = agentPickerPanelArguments(entry, draft)
  return agentModelChoiceChips(
    entry.agent,
    entry.label,
    argumentsView.choices,
    (patch) => {
      const key =
        patch.model !== undefined
          ? 'model'
          : patch.permissionMode !== undefined
            ? 'permissionMode'
            : Object.keys(patch.options ?? {})[0]
      editDraft({ kind: 'remove-chip', key })
      return agentPickerPanelArguments(entry, getDraft() ?? draft).text
    },
    argumentsView.context
  )
}

export function savedEffortChip(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  models: AgentPickerModel[],
  currentModel: string | undefined,
  chips: ReturnType<typeof agentLaunchSetupChoiceChips>,
  disabled: boolean | undefined
) {
  const argumentsView = agentPickerPanelArguments(entry, draft)
  const saved = argumentsView.choices.options?.effort
  if (
    entry.agent !== 'antigravity' ||
    draft.surface !== 'terminal' ||
    !saved ||
    antigravityModelSelection(models, currentModel)?.row.efforts.some(
      ({ value }) => value === saved
    )
  ) {
    return null
  }
  const hidden = chips.filter(({ key }) => key === 'effort')
  return hidden.length ? (
    <div className="h-5">
      <AgentArgsChoiceChips
        chips={hidden}
        disabled={disabled}
        onRemove={(chip) => chip.onRemove(argumentsView.text ?? '')}
      />
    </div>
  ) : null
}

export function agentLaunchDisplayModel(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  models: AgentPickerModel[],
  currentModel: string | undefined
) {
  return entry.agent === 'antigravity' && draft.surface === 'terminal'
    ? (antigravityModelSelection(models, currentModel)?.row.id ?? currentModel)
    : currentModel
}
