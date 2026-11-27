import { translate } from '@/i18n/i18n'
import { agentPickerChatLaunchModel } from '../../../../shared/agent-launch/picker/agent-launch-picker-chat-model'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

/** Why a chat launch can't run the form's model pick, or null when it can. */
export function agentPickerChatLaunchRefusal(
  entry: AgentPickerEntry,
  draft: Pick<AgentPickerDraft, 'choices'>
): string | null {
  const picked = draft.choices.model
  const result = agentPickerChatLaunchModel(entry, picked)
  if (!('refusal' in result)) {
    return null
  }
  const listed =
    entry.catalog.origin === 'unknown'
      ? undefined
      : entry.catalog.models.find((model) => model.id === picked)
  const values = { agent: entry.label, model: listed?.label ?? picked }
  switch (result.refusal) {
    case 'shared':
      return translate(
        'agentPicker.chatModelShared',
        "A {{agent}} chat can't pick {{model}} because another provider offers the same model. Launch it in a terminal, or pick another model.",
        values
      )
    case 'unlisted':
      return translate(
        'agentPicker.chatModelUnlisted',
        "{{model}} isn't in {{agent}}'s model list, so a chat can't run it. Pick another model.",
        values
      )
    case 'unproven':
      return translate(
        'agentPicker.chatModelUnproven',
        "{{agent}}'s model list hasn't finished loading, so a chat can't confirm {{model}} yet. Try again in a moment, or launch it in a terminal.",
        values
      )
  }
}
