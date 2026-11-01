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
        (valueKnown ||
          option.kind.type === 'select' ||
          Boolean(currentModel && draft.delegated?.includes(option.id))) &&
        (!(option.id === 'fastMode' || option.id === 'serviceTier') ||
          !entry.surfaces.includes('terminal') ||
          argumentsKnown)
    }
  })
}

export function agentLaunchSetupCatalogState(
  entry: AgentPickerEntry,
  models: readonly { hidden?: true }[]
) {
  const hasModels = models.some((model) => !model.hidden)
  const catalogPending =
    !hasModels &&
    ((entry.catalogRead === undefined && entry.catalog.origin === 'unknown') ||
      entry.catalogRead === 'pending')
  const catalogMessage = catalogPending
    ? null
    : entry.catalogRead === 'unsupported'
      ? translate(
          'agentPicker.catalogUnsupported',
          '{{agent}} models are unavailable on this host. You can keep your current choices or use Arguments.',
          { agent: entry.label }
        )
      : entry.catalogRead === 'failed'
        ? translate(
            'agentPicker.catalogFailed',
            'Could not load {{agent}} models. Close and reopen the agent picker to try again.',
            { agent: entry.label }
          )
        : entry.catalog.unavailable?.reason === 'notSignedIn'
          ? translate(
              'agentPicker.catalogSignIn',
              'Sign in to {{agent}} to load its models, then close and reopen the agent picker.',
              { agent: entry.label }
            )
          : entry.catalog.unavailable?.reason === 'cliMissing'
            ? translate(
                'agentPicker.catalogInstall',
                'Install {{agent}} on this host to load its models, then close and reopen the agent picker.',
                { agent: entry.label }
              )
            : entry.catalog.unavailable
              ? translate(
                  'agentPicker.catalogUnresolved',
                  '{{agent}} models have not loaded. Close and reopen the agent picker to try again.',
                  { agent: entry.label }
                )
              : entry.catalog.origin === 'unknown' || entry.catalog.listingInProgress
                ? !hasModels
                  ? translate(
                      'agentPicker.catalogUnresolved',
                      '{{agent}} models have not loaded. Close and reopen the agent picker to try again.',
                      { agent: entry.label }
                    )
                  : null
                : !hasModels
                  ? translate('agentPicker.catalogEmpty', '{{agent}} has no available models.', {
                      agent: entry.label
                    })
                  : null
  return { hasModels, catalogPending, catalogMessage }
}
