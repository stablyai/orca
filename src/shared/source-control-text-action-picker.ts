import type { AgentPickerEntry, AgentPickerDraft } from './agent-launch-picker'
import type { AgentDedicatedChoices } from './agent-launch-choices'

export const TEXT_ACTION_DEFAULT_MODEL = '__text_action_default__'
export type TextActionPickerCatalog = {
  defaultLabel: string
  modelInArguments: boolean
  effortInArguments: boolean
  modelArgumentsUnrecognized: boolean
  effortArgumentsUnrecognized: boolean
  /** The CLI takes effort inside the model operand (`model#variant`), so it follows the model's owner. */
  effortInModel: boolean
  effortByModel: Record<string, string | undefined>
}

/** Arguments keep the model until a staged Model pick has removed every flag they set it with. */
export function textActionArgumentsOwnModel(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): boolean {
  const text = entry.textGeneration
  return Boolean(
    text?.modelInArguments &&
    (!draft.textChanges?.includes('model') || text.modelArgumentsUnrecognized)
  )
}

/** Effort for a model set in Arguments is edited in Arguments or after choosing Model. */
export function textActionArgumentsOwnEffort(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): boolean {
  return Boolean(entry.textGeneration?.effortInModel && textActionArgumentsOwnModel(entry, draft))
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
