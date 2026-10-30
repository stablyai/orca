import { translate } from '@/i18n/i18n'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import type {
  agentPickerEntryOptions,
  agentPickerModels,
  AgentPickerEntry,
  AgentPickerDraft
} from '../../../../shared/agent-launch-picker'
import type { agentPickerPanelArguments } from '../../../../shared/agent-launch-picker-arguments'

type AgentLaunchSetupOptionRowsInput = {
  options: ReturnType<typeof agentPickerEntryOptions>
  models: ReturnType<typeof agentPickerModels>
  entry: AgentPickerEntry
  draft: AgentPickerDraft
  currentModel: string | undefined
  argumentsView: ReturnType<typeof agentPickerPanelArguments>
  defaultsPending: boolean | undefined
  disabled: boolean | undefined
  argumentsKnown: boolean
}

export function agentLaunchSetupOptionRows({
  options,
  models,
  entry,
  draft,
  currentModel,
  argumentsView,
  defaultsPending,
  disabled,
  argumentsKnown
}: AgentLaunchSetupOptionRowsInput): SessionOptionDescriptor[] {
  return options.map((option) => {
    const liveModel = models.find((model) => model.id === currentModel)
    const current =
      argumentsView.choices.options?.[option.id] ??
      (currentModel && !defaultsPending && !draft.delegated?.includes(option.id)
        ? option.kind.type === 'boolean'
          ? String(option.kind.defaultValue)
          : option.id === 'effort'
            ? liveModel?.defaultEffort
            : option.kind.defaultIsCliDefault
              ? option.kind.defaultValue
              : undefined
        : undefined)
    if (argumentsView.context.analysis.opaqueKeys.has(option.id)) {
      return {
        id: option.id,
        label: option.label,
        category: option.category,
        kind: {
          type: 'select',
          choices: [
            {
              value: 'arguments',
              label: translate('agentPicker.setByArguments', 'Set by your Arguments')
            }
          ],
          currentValue: 'arguments'
        },
        valueSource: 'default',
        transport: 'agent-session',
        settable: false
      }
    }
    const valueKnown =
      current !== undefined ||
      (option.id === 'serviceTier' &&
        entry.catalog.origin !== 'unknown' &&
        Boolean(liveModel?.serviceTiers?.length))
    return {
      id: option.id,
      label: option.label,
      category: option.category,
      kind:
        option.kind.type === 'boolean'
          ? { type: 'boolean', currentValue: current === 'true' }
          : {
              type: 'select',
              choices:
                current && !option.kind.choices.some((choice) => choice.value === current)
                  ? [...option.kind.choices, { value: current, label: current }]
                  : option.kind.choices,
              currentValue: current
            },
      valueSource: valueKnown ? 'default' : 'unknown',
      transport: 'agent-session',
      settable:
        !disabled &&
        !defaultsPending &&
        // A settled level the agent picks itself shows unselected but stays pickable.
        (valueKnown || option.kind.type === 'select') &&
        (!(option.id === 'fastMode' || option.id === 'serviceTier') ||
          !entry.surfaces.includes('terminal') ||
          argumentsKnown)
    }
  })
}
