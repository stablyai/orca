import {
  agentPickerModelMenu,
  agentPickerUsesComposerModelMenu
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import {
  TEXT_ACTION_DEFAULT_MODEL,
  textActionArgumentsOwnEffort
} from '../../../../shared/agent-launch/picker/agent-launch-picker-text-action'
import { withLaunchEffortDefault } from './agent-launch-setup-default-effort'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../../../../shared/native-chat/input/native-chat-session-options'
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

/** Clearing Effort keeps the selected model, so its default is that model's inherited effort.
 *  Why short: it sits in the effort row beside every level; its name still says what it inherits. */
function textEffortDefaultChoice(
  kind: {
    choices: readonly { value: string; label: string }[]
    defaultValue: string
  },
  t: Translate = translate
): SessionOptionSelectChoice {
  const effort = kind.choices.find((choice) => choice.value === kind.defaultValue)?.label
  const short = t('settings.sourceControl.actionModel.effortDefault', 'Default')
  return {
    value: TEXT_ACTION_DEFAULT_MODEL,
    label: effort
      ? t('agentPicker.sameAsTextDefault', 'Same as default · {{value0}}', { value0: effort })
      : short,
    shortLabel: short
  }
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
  const effort = agentPickerModelMenu(entry, draft.surface, {
    ...(currentModel ? { model: currentModel } : {}),
    ...argumentsView.choices.options
  }).descriptors.find((row) => row.id === 'effort')
  const kiroLaunchEffort =
    entry.agent === 'kiro' && options.some((option) => option.id === 'effort')
  const sharedEffort =
    !kiroLaunchEffort && agentPickerUsesComposerModelMenu(entry, draft.surface) ? effort : undefined
  const rows: SessionOptionDescriptor[] = options
    .filter((option) => !sharedEffort || option.id !== 'effort')
    .map((option) => {
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
                        ? [textEffortDefaultChoice(option.kind, t)]
                        : []),
                      ...option.kind.choices
                    ]
                  : option.id !== 'serviceTier' &&
                      current &&
                      !option.kind.choices.some((choice) => choice.value === current)
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
  if (sharedEffort) {
    rows.push(
      argumentsView.context.analysis.opaqueKeys.has('effort')
        ? argumentsOwnedRow('effort', sharedEffort.label, sharedEffort.category, t)
        : {
            ...sharedEffort,
            settable: sharedEffort.settable && !disabled && !defaultsPending
          }
    )
  }
  return withLaunchEffortDefault(rows, entry, draft, t)
}

export function agentLaunchSetupCatalogState(
  entry: AgentPickerEntry,
  models: readonly { id: string; hidden?: true }[],
  currentModel: string | undefined,
  t: Translate = translate
) {
  const hasModels = models.some((model) => !model.hidden)
  const hasUsableModels =
    hasModels || Boolean(currentModel && !models.some((model) => model.id === currentModel))
  const catalogPending = !hasUsableModels && entry.catalogRead === 'pending'
  const settled = !hasUsableModels && !catalogPending
  const unsupported =
    settled &&
    (entry.catalogRead === 'unsupported' ||
      (!hasModels && entry.catalog.origin === 'unknown' && entry.catalogRead === undefined))
  const missing =
    !settled || unsupported
      ? null
      : entry.catalogRead === 'failed'
        ? t('agentPicker.catalogLoadFailed', 'Could not load {{agent}} models.', {
            agent: entry.label
          })
        : entry.catalog.unavailable?.reason === 'notSignedIn'
          ? t('agentPicker.catalogSignInToLoad', 'Sign in to {{agent}} to load its models.', {
              agent: entry.label
            })
          : entry.catalog.unavailable?.reason === 'cliMissing'
            ? t(
                'agentPicker.catalogInstallToLoad',
                'Install {{agent}} on this host to load its models.',
                { agent: entry.label }
              )
            : entry.catalog.unavailable ||
                ((entry.catalog.origin === 'unknown' || entry.catalog.listingInProgress) &&
                  !hasModels)
              ? t('agentPicker.catalogNotLoaded', '{{agent}} models have not loaded.', {
                  agent: entry.label
                })
              : null
  const catalogMessage = catalogPending
    ? t('agentPicker.catalogLoading', 'Loading models…')
    : unsupported
      ? t(
          'agentPicker.catalogUnsupportedLaunch',
          '{{agent}} models are unavailable on this host. Your current choices still apply.',
          { agent: entry.label }
        )
      : (missing ??
        (settled && !hasModels
          ? t('agentPicker.catalogEmpty', '{{agent}} has no available models.', {
              agent: entry.label
            })
          : null))
  // Retry reads the models again in place; an empty or unsupported answer would just repeat.
  const catalogRetryable = missing !== null
  return { hasModels, catalogPending, catalogMessage, catalogRetryable }
}

/** Visible model rows, the expanded legacy rows below their toggle, and the model the list starts on. */
export function agentLaunchSetupModelRows(
  models: readonly AgentPickerModel[],
  currentModel: string | undefined,
  query: string,
  legacyExpanded: boolean,
  modelInArguments: boolean
) {
  type Row = { id: string; label: string; unlisted?: true }
  // A hidden row is listed by a matching search, or while it is the current choice.
  const listed = models.filter((model) => !model.hidden || query || model.id === currentModel)
  // Membership ignores the selection, so picking a model never moves rows in the open list.
  const folded = (model: AgentPickerModel) => !query && Boolean(model.isLegacy)
  const rows: Row[] = listed.filter((model) => !folded(model))
  const legacyRows: Row[] = listed.filter(folded)
  const shownLegacy = legacyExpanded ? legacyRows : []
  // Why one keyed list: when the catalog later lists an unlisted current model, its row keeps
  // its identity, so the highlight stays on it instead of jumping to the first model.
  if (currentModel && !models.some((model) => model.id === currentModel)) {
    rows.push({ id: currentModel, label: currentModel, unlisted: true })
  }
  // An Arguments-owned text action has no current model row, so it starts on its default as before.
  const start =
    !modelInArguments && [...rows, ...shownLegacy].some((row) => row.id === currentModel)
      ? currentModel
      : undefined
  return {
    rows,
    legacyRows: shownLegacy,
    legacyCount: legacyRows.length,
    start
  }
}
