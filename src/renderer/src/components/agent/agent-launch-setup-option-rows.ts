import {
  TEXT_ACTION_DEFAULT_MODEL,
  textActionArgumentsOwnEffort
} from '../../../../shared/agent-launch/picker/agent-launch-picker-text-action'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import type {
  agentPickerEntryOptions,
  agentPickerModels
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import type {
  AgentPickerEntry,
  AgentPickerDraft,
  AgentPickerModel
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { agentPickerPanelArguments } from '../../../../shared/agent-launch/picker/agent-launch-picker-arguments'

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

function argumentsOwnedRow(
  id: string,
  label: string,
  category: SessionOptionDescriptor['category'],
  t: Translate = translate
): SessionOptionDescriptor {
  return {
    id,
    label,
    category,
    kind: {
      type: 'select',
      choices: [
        {
          value: 'arguments',
          label: t('agentPicker.setByArguments', 'Set by your Arguments')
        }
      ],
      currentValue: 'arguments'
    },
    valueSource: 'default',
    transport: 'agent-session',
    settable: false
  }
}

/** Clearing Effort keeps the selected model, so its default is that model's inherited effort. */
function textEffortDefaultLabel(
  kind: {
    choices: readonly { value: string; label: string }[]
    defaultValue: string
  },
  t: Translate = translate
): string {
  const effort = kind.choices.find((choice) => choice.value === kind.defaultValue)?.label
  return effort
    ? t('agentPicker.sameAsTextDefault', 'Same as default · {{value0}}', {
        value0: effort
      })
    : t('settings.sourceControl.actionModel.effortDefault', 'Default')
}

export function agentLaunchSetupOptionRows(
  {
    options,
    models,
    entry,
    draft,
    currentModel,
    argumentsView,
    defaultsPending,
    disabled,
    argumentsKnown
  }: AgentLaunchSetupOptionRowsInput,
  t: Translate = translate
): SessionOptionDescriptor[] {
  // Shown even when the menu's model has no levels, so Effort explains where it is set.
  if (textActionArgumentsOwnEffort(entry, draft)) {
    return [
      argumentsOwnedRow('effort', options[0]?.label ?? 'Reasoning effort', 'thought_level', t)
    ]
  }
  return options.map((option) => {
    const effortInArguments =
      entry.textGeneration?.effortInArguments &&
      (!draft.textChanges?.includes('effort') || entry.textGeneration.effortArgumentsUnrecognized)
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
      return argumentsOwnedRow(option.id, option.label, option.category, t)
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
              choices: entry.textGeneration
                ? [
                    ...(effortInArguments
                      ? [
                          {
                            value: 'arguments',
                            label: t('agentPicker.setByArguments', 'Set by your Arguments')
                          }
                        ]
                      : []),
                    ...(entry.textGeneration.defaultLabel !== undefined
                      ? [
                          {
                            value: TEXT_ACTION_DEFAULT_MODEL,
                            label: textEffortDefaultLabel(option.kind, t)
                          }
                        ]
                      : []),
                    ...option.kind.choices
                  ]
                : current && !option.kind.choices.some((choice) => choice.value === current)
                  ? [...option.kind.choices, { value: current, label: current }]
                  : option.kind.choices,
              currentValue: effortInArguments ? 'arguments' : current
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

/** Speed rows sit apart from the rest; launch also lifts level rows onto speed's line. */
export function agentLaunchSetupRowGroups(rows: SessionOptionDescriptor[], launch: boolean) {
  const isSpeed = (row: SessionOptionDescriptor) =>
    row.id === 'fastMode' || row.id === 'serviceTier'
  const isLevel = (row: SessionOptionDescriptor) =>
    launch && !isSpeed(row) && row.category === 'thought_level' && row.kind.type === 'select'
  return {
    level: rows.filter(isLevel),
    speed: rows.filter(isSpeed),
    rest: rows.filter((row) => !isSpeed(row) && !isLevel(row))
  }
}

export function agentLaunchSetupCatalogState(
  entry: AgentPickerEntry,
  models: readonly { id: string; hidden?: true }[],
  currentModel: string | undefined,
  mode: 'launch' | 'select',
  t: Translate = translate
) {
  const hasModels = models.some((model) => !model.hidden)
  const hasUsableModels =
    hasModels || Boolean(currentModel && !models.some((model) => model.id === currentModel))
  const catalogPending = !hasUsableModels && entry.catalogRead === 'pending'
  const catalogMessage =
    hasUsableModels || catalogPending
      ? null
      : entry.catalogRead === 'unsupported' ||
          (!hasModels && entry.catalog.origin === 'unknown' && entry.catalogRead === undefined)
        ? mode === 'launch'
          ? t(
              'agentPicker.catalogUnsupportedLaunch',
              '{{agent}} models are unavailable on this host. Your current choices still apply.',
              { agent: entry.label }
            )
          : t(
              'agentPicker.catalogUnsupported',
              '{{agent}} models are unavailable on this host. You can keep your current choices or use Arguments.',
              { agent: entry.label }
            )
        : entry.catalogRead === 'failed'
          ? t(
              'agentPicker.catalogFailed',
              'Could not load {{agent}} models. Close and reopen the agent picker to try again.',
              { agent: entry.label }
            )
          : entry.catalog.unavailable?.reason === 'notSignedIn'
            ? t(
                'agentPicker.catalogSignIn',
                'Sign in to {{agent}} to load its models, then close and reopen the agent picker.',
                { agent: entry.label }
              )
            : entry.catalog.unavailable?.reason === 'cliMissing'
              ? t(
                  'agentPicker.catalogInstall',
                  'Install {{agent}} on this host to load its models, then close and reopen the agent picker.',
                  { agent: entry.label }
                )
              : entry.catalog.unavailable
                ? t(
                    'agentPicker.catalogUnresolved',
                    '{{agent}} models have not loaded. Close and reopen the agent picker to try again.',
                    { agent: entry.label }
                  )
                : entry.catalog.origin === 'unknown' || entry.catalog.listingInProgress
                  ? !hasModels
                    ? t(
                        'agentPicker.catalogUnresolved',
                        '{{agent}} models have not loaded. Close and reopen the agent picker to try again.',
                        { agent: entry.label }
                      )
                    : null
                  : !hasModels
                    ? t('agentPicker.catalogEmpty', '{{agent}} has no available models.', {
                        agent: entry.label
                      })
                    : null
  return { hasModels, catalogPending, catalogMessage }
}

/** Visible model rows, plus the model the list starts on. */
export function agentLaunchSetupModelRows(
  models: readonly AgentPickerModel[],
  currentModel: string | undefined,
  query: string,
  legacy: boolean,
  modelInArguments: boolean
) {
  const rows: { id: string; label: string; unlisted?: true }[] = models.filter(
    (model) =>
      !model.hidden && (model.id === currentModel || query || Boolean(model.isLegacy) === legacy)
  )
  // Why one keyed list: when the catalog later lists an unlisted current model, its row keeps
  // its identity, so the highlight stays on it instead of jumping to the first model.
  if (currentModel && !models.some((model) => model.id === currentModel)) {
    rows.push({ id: currentModel, label: currentModel, unlisted: true })
  }
  // An Arguments-owned text action has no current model row, so it starts on its default as before.
  const start =
    !modelInArguments && rows.some((row) => row.id === currentModel) ? currentModel : undefined
  return { rows, start }
}
