import {
  TEXT_ACTION_DEFAULT_MODEL,
  textActionArgumentsOwnModel
} from '../../../../shared/agent-launch/picker/agent-launch-picker-text-action'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from '../../../../shared/agent-session/options/agent-session-option-catalog'
import { claudeListedModelLabel } from '../../../../shared/agent-session/options/model-catalog/claude-model-list-probe'
import { readHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { agentPickerArgumentsKnown } from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch/picker/agent-launch-picker-arguments'
import { isFastServiceTier } from '../../../../shared/agent-session/options/model-catalog/structured-agent-session-discovered-model'
import { nativeChatSessionChoiceShortLabel } from '../../../../shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from '../native-chat/session/options/controls/native-chat-session-option-labels-text'
import {
  agentPickerEntryOptions,
  agentPickerModels
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import {
  agentPickerEffectiveChoices,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  agentLaunchSetupCatalogState,
  agentLaunchSetupOptionRows
} from './agent-launch-setup-option-rows'

/** What the setup pane shows for one agent's draft: its models, current model and option rows. */
export function agentLaunchSetupState(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  disabled?: boolean
) {
  const argumentsKnown = agentPickerArgumentsKnown(entry, draft)
  const effective = agentPickerEffectiveChoices(entry, draft)
  const argumentsView = agentPickerPanelArguments(entry, draft)
  const models = agentPickerModels(entry, draft.surface)
  const defaultsPending =
    draft.surface === 'chat' ? entry.structuredDefaultsPending : entry.defaultsPending
  const seed = getAgentSessionOptionLaunchCatalog(entry.agent)
  const listedDefaultKnown =
    entry.catalog.origin !== 'unknown' &&
    (entry.catalog.listingNamesConfiguredModel ?? seed?.hostListingNamesConfiguredModel === true)
  const currentModel =
    argumentsView.choices.model ??
    effective.model ??
    (!draft.delegated?.includes('model') && !defaultsPending && listedDefaultKnown
      ? models.find((model) => model.isDefault)?.id
      : undefined)
  // Settled with nothing chosen still lets the user pick; nothing is checked and the agent keeps its own default.
  const catalog = agentLaunchSetupCatalogState(entry, models, currentModel)
  const options = agentPickerEntryOptions(entry, currentModel, draft.surface)
  return {
    argumentsView,
    models,
    currentModel,
    ...catalog,
    modelInArguments: textActionArgumentsOwnModel(entry, draft),
    modelDisabled: Boolean(disabled || defaultsPending || catalog.catalogPending),
    optionRows: agentLaunchSetupOptionRows({
      options,
      models,
      entry,
      draft,
      currentModel,
      argumentsView,
      defaultsPending,
      disabled,
      argumentsKnown
    })
  }
}

/** "Claude Opus 5.5 · Med · Fast": the model, level and speed a launch with this draft uses. */
export function agentLaunchSetupSummary(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): string[] {
  const state = agentLaunchSetupState(entry, draft)
  const model =
    state.modelInArguments || !state.currentModel
      ? undefined
      : state.currentModel === TEXT_ACTION_DEFAULT_MODEL
        ? entry.textGeneration?.defaultLabel
        : (state.models.find((candidate) => candidate.id === state.currentModel)?.label ??
          agentLaunchModelLabel(entry, state.currentModel))
  const level = state.optionRows.find(
    (row) => row.category === 'thought_level' && row.kind.type === 'select'
  )
  const levelKind = level?.kind.type === 'select' ? level.kind : undefined
  const levelChoice = levelKind?.choices.find((choice) => choice.value === levelKind.currentValue)
  const speed = state.optionRows.find(
    (row) => row.id === 'fastMode' || row.id === 'serviceTier'
  )?.kind
  const fast =
    speed?.type === 'boolean'
      ? speed.currentValue
      : speed?.type === 'select' &&
        speed.choices.some(
          (choice) => choice.value === speed.currentValue && isFastServiceTier(choice)
        )
  return [
    model,
    levelChoice &&
    level &&
    levelChoice.value !== 'arguments' &&
    levelChoice.value !== TEXT_ACTION_DEFAULT_MODEL
      ? nativeChatSessionChoiceShortLabel(levelChoice, say, level.id)
      : undefined,
    fast ? say('fast') : undefined
  ].filter((part): part is string => Boolean(part))
}

/** A model's name without its host's listing loaded: the cached listing, the release's catalog, then the id. */
function agentLaunchModelLabel(entry: AgentPickerEntry, modelId: string): string {
  const target = structuredAgentSessionTargetForHost(entry.rows[0]?.executionHostId ?? 'local')
  const cached = target
    ? readHostModelCatalogSnapshot(target, entry.agent, { newLaunch: true, seedsModel: true })
    : undefined
  const listed =
    cached && cached.origin !== 'unknown'
      ? cached.models.find((candidate) => candidate.id === modelId)?.label
      : undefined
  const seed = getAgentSessionOptionLaunchCatalog(entry.agent)
  return (
    listed ??
    (seed ? findCatalogModel(seed, modelId)?.label : undefined) ??
    // Claude's listing names a row by the model id it runs; reuse that naming.
    (entry.agent === 'claude' ? claudeListedModelLabel(modelId) : modelId)
  )
}
