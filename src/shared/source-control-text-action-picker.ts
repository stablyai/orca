import type { AgentPickerEntry, AgentPickerDraft } from './agent-launch-picker'
import type { AgentDedicatedChoices } from './agent-launch-choices'

export const TEXT_ACTION_DEFAULT_MODEL = '__text_action_default__'
export type TextActionPickerCatalog = {
  defaultLabel: string
  modelInArguments: boolean
  effortInArguments: boolean
  modelArgumentsUnrecognized: boolean
  effortArgumentsUnrecognized: boolean
  effortByModel: Record<string, string | undefined>
}

export function textActionPickerEffectiveChoices(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): AgentDedicatedChoices {
  const model = draft.choices.model ?? entry.terminal.model
  const live =
    entry.catalog.origin !== 'unknown'
      ? entry.catalog.models.find((row) => row.id === model)
      : undefined
  const effort = draft.choices.options?.effort ?? live?.defaultEffort
  return {
    model,
    options: live?.efforts.some((level) => level.value === effort)
      ? { effort }
      : live?.defaultEffort
        ? { effort: live.defaultEffort }
        : {}
  }
}
