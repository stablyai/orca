import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import type {
  AgentSessionOptionCatalog,
  CatalogMidSessionApply,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog'
import type {
  NativeChatLiveOptionTransport,
  SessionOptionDescriptor,
  SessionOptionSelectChoice,
  SessionOptionValueSource
} from './native-chat-session-options'
import {
  isFlipOnlyMidSession,
  type NativeChatSessionOptionRecord,
  type TrackedNativeChatSessionOption
} from './native-chat-session-option-state'

export type NativeChatSessionOptionMode = 'draft' | 'live'
export type { NativeChatLiveOptionTransport }

function choiceWithCurrent(
  choices: readonly SessionOptionSelectChoice[],
  tracked: TrackedNativeChatSessionOption | undefined
): SessionOptionSelectChoice[] {
  const result = [...choices]
  const current = typeof tracked?.value === 'string' ? tracked.value : null
  if (current && !result.some((choice) => choice.value === current)) {
    result.push({ value: current, label: current })
  }
  return result
}

function settableState(args: {
  mode: NativeChatSessionOptionMode
  liveTransport: NativeChatLiveOptionTransport
  apply: { launchArgs?: unknown; composedIntoModel?: true; midSession?: CatalogMidSessionApply }
  composedModelApply?: { midSession?: CatalogMidSessionApply }
}): Pick<SessionOptionDescriptor, 'settable' | 'disabledReason'> {
  if (args.mode === 'draft') {
    return args.apply.launchArgs || args.apply.composedIntoModel
      ? { settable: true }
      : { settable: false, disabledReason: 'available-after-session-start' }
  }
  if (args.liveTransport === 'agent-session') {
    return { settable: true }
  }
  if (args.apply.composedIntoModel && args.composedModelApply?.midSession?.kind === 'command') {
    return { settable: true }
  }
  const midSession = args.apply.midSession
  return midSession && midSession.kind !== 'unsupported'
    ? { settable: true }
    : { settable: false, disabledReason: 'set-when-session-starts' }
}

function actionForApply(
  apply: { midSession?: CatalogMidSessionApply },
  tracked: TrackedNativeChatSessionOption | undefined,
  mode: NativeChatSessionOptionMode,
  liveTransport: NativeChatLiveOptionTransport
): SessionOptionDescriptor['action'] {
  if (mode !== 'live' || liveTransport === 'agent-session') {
    return undefined
  }
  if (apply.midSession?.kind === 'agent-picker') {
    return { type: 'agent-picker' }
  }
  // Unknown flip-only options need actions; tracked baselines permit absolute On/Off controls.
  return isFlipOnlyMidSession(apply.midSession) && !tracked ? { type: 'toggle-command' } : undefined
}

function optionDescriptor(args: {
  option: CatalogOption
  tracked: TrackedNativeChatSessionOption | undefined
  mode: NativeChatSessionOptionMode
  liveTransport: NativeChatLiveOptionTransport
  modelIsCliDefault: boolean
  composedModelApply: AgentSessionOptionCatalog['modelApply']
}): SessionOptionDescriptor | null {
  const { option, tracked, mode, liveTransport, modelIsCliDefault, composedModelApply } = args
  const action = actionForApply(option.apply, tracked, mode, liveTransport)
  const settable = settableState({ mode, liveTransport, apply: option.apply, composedModelApply })
  // Draft options emit flags only with a chosen model; CLI-default values are nameable only when its listing proves them.
  const cliStatesDefault =
    modelIsCliDefault && option.kind.type === 'select' && option.kind.defaultIsCliDefault === true
  const showDefault = !tracked && (cliStatesDefault || (mode === 'draft' && !modelIsCliDefault))
  const valueSource = tracked?.source ?? (showDefault ? 'default' : 'unknown')
  if (option.kind.type === 'select') {
    const choices = choiceWithCurrent(option.kind.choices, tracked)
    if (choices.length <= 1) {
      return null
    }
    const currentValue =
      typeof tracked?.value === 'string'
        ? tracked.value
        : showDefault
          ? option.kind.defaultValue
          : undefined
    return {
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
      kind: {
        type: 'select',
        ...(currentValue === undefined ? {} : { currentValue }),
        choices
      },
      valueSource,
      transport: liveTransport,
      ...settable,
      ...(action ? { action } : {})
    }
  }
  // A switch has no unknown position. Resolve to defaultValue like composed dispatch, but keep unknown/default provenance so pills cannot claim confirmation.
  const currentValue =
    typeof tracked?.value === 'boolean' ? tracked.value : option.kind.defaultValue
  return {
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.category ? { category: option.category } : {}),
    kind: {
      type: 'boolean',
      currentValue
    },
    valueSource,
    transport: liveTransport,
    ...settable,
    ...(action ? { action } : {})
  }
}

// Effort before model config before modes; anything uncategorized sorts last.
const CATEGORY_ORDER: Record<string, number> = {
  thought_level: 0,
  model_config: 1,
  mode: 2
}

/** Shared desktop/mobile option ordering; exclude model and the separately rendered permission pill. */
export function sortNativeChatSessionOptions(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return snapshot
    .filter(
      (descriptor) =>
        descriptor.category !== 'model' && descriptor.id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID
    )
    .sort((left, right) => {
      const leftOrder = CATEGORY_ORDER[left.category ?? ''] ?? 3
      const rightOrder = CATEGORY_ORDER[right.category ?? ''] ?? 3
      return leftOrder - rightOrder
    })
}

/** Keep persisted/unlisted aliases and their model-specific options selectable. Both platforms must reconcile before snapshotting. */
export function withTrackedNativeChatModel(
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  record: Pick<NativeChatSessionOptionRecord, 'model'>
): CatalogModel[] {
  const trackedId = typeof record.model?.value === 'string' ? record.model.value : null
  if (!trackedId || models.some((model) => model.id === trackedId)) {
    return [...models]
  }
  const seeded = catalog.models.find((model) => model.id === trackedId)
  return [...models, seeded ?? { id: trackedId, label: trackedId, options: [] }]
}

/** No tracked model means no -m; name the CLI default only when the catalog proves it. */
function cliDefaultModelId(
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  trackedModelId: string | null
): string | null {
  if (trackedModelId || !catalog.defaultModelIsCliDefault) {
    return null
  }
  return models.find((model) => model.isDefault)?.id ?? null
}

/** Resolve the model shown by the picker so applying options uses the same tracked/default row. */
export function resolveEffectiveNativeChatModelId(
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  record: NativeChatSessionOptionRecord
): string | null {
  const trackedModelId = typeof record.model?.value === 'string' ? record.model.value : null
  return trackedModelId ?? cliDefaultModelId(catalog, models, trackedModelId)
}

/** The model the trigger names, and where that came from; a null id names none. */
export type NativeChatShownModel = {
  currentId: string | null
  valueSource: SessionOptionValueSource
  tracked: TrackedNativeChatSessionOption | undefined
}

/** The model descriptor, then the controls that apply, each showing the chat's value for it.
 *  Values and controls arrive apart, so a caller decides which model's controls apply. */
export function nativeChatSessionOptionDescriptors(args: {
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  mode: NativeChatSessionOptionMode
  modelLabel: string
  liveTransport: NativeChatLiveOptionTransport
  model: NativeChatShownModel
  controls: readonly CatalogOption[]
  values: Readonly<Record<string, TrackedNativeChatSessionOption | undefined>>
  modelIsCliDefault: boolean
}): SessionOptionDescriptor[] {
  const { catalog, models, mode, modelLabel, liveTransport, model } = args
  // Callers reconcile tracked models into choices first; the trigger must never show an unlisted selection.
  const modelChoices = models.map(({ id, label, description }) => ({
    value: id,
    label,
    ...(description ? { description } : {})
  }))
  const modelAction = actionForApply(catalog.modelApply, model.tracked, mode, liveTransport)
  const snapshot: SessionOptionDescriptor[] = [
    {
      id: 'model',
      label: modelLabel,
      category: 'model',
      kind: {
        type: 'select',
        ...(model.currentId ? { currentValue: model.currentId } : {}),
        choices: modelChoices
      },
      valueSource: model.valueSource,
      transport: liveTransport,
      ...settableState({ mode, liveTransport, apply: catalog.modelApply }),
      ...(modelAction ? { action: modelAction } : {})
    }
  ]
  for (const option of args.controls) {
    const descriptor = optionDescriptor({
      option,
      tracked: args.values[option.id],
      mode,
      liveTransport,
      modelIsCliDefault: args.modelIsCliDefault,
      composedModelApply: catalog.modelApply
    })
    if (descriptor) {
      snapshot.push(descriptor)
    }
  }
  return snapshot
}

/** A terminal chat's picker, whose values are remembered per model. */
export function buildNativeChatSessionOptionSnapshot(args: {
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  record: NativeChatSessionOptionRecord
  mode: NativeChatSessionOptionMode
  modelLabel: string
  /** Require producers to name their lane; defaulting could silently inherit the other transport’s rendering. */
  liveTransport: NativeChatLiveOptionTransport
}): SessionOptionDescriptor[] {
  const { catalog, models, record } = args
  if (models.length === 0) {
    return []
  }
  const trackedModelId = typeof record.model?.value === 'string' ? record.model.value : null
  const defaultModelId = cliDefaultModelId(catalog, models, trackedModelId)
  const effectiveModelId = trackedModelId ?? defaultModelId
  const model = models.find((candidate) => candidate.id === effectiveModelId)
  return nativeChatSessionOptionDescriptors({
    ...args,
    model: {
      currentId: effectiveModelId,
      valueSource: record.model?.source ?? (defaultModelId ? 'default' : 'unknown'),
      tracked: record.model
    },
    controls: effectiveModelId ? (model?.options ?? []) : [],
    values: effectiveModelId ? (record.valuesByModel[effectiveModelId] ?? {}) : {},
    modelIsCliDefault: effectiveModelId === defaultModelId
  })
}
