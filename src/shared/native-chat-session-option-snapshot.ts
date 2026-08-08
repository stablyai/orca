import type {
  AgentSessionOptionCatalog,
  CatalogMidSessionApply,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from './native-chat-session-options'
import {
  isFlipOnlyMidSession,
  type NativeChatSessionOptionRecord,
  type TrackedNativeChatSessionOption
} from './native-chat-session-option-state'

export type NativeChatSessionOptionMode = 'draft' | 'live'

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
  apply: { launchArgs?: unknown; composedIntoModel?: true; midSession?: CatalogMidSessionApply }
  composedModelApply?: { midSession?: CatalogMidSessionApply }
}): Pick<SessionOptionDescriptor, 'settable' | 'disabledReason'> {
  if (args.mode === 'draft') {
    return args.apply.launchArgs || args.apply.composedIntoModel
      ? { settable: true }
      : { settable: false, disabledReason: 'available-after-session-start' }
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
  mode: NativeChatSessionOptionMode
): SessionOptionDescriptor['action'] {
  if (mode !== 'live') {
    return undefined
  }
  if (apply.midSession?.kind === 'agent-picker') {
    return { type: 'agent-picker' }
  }
  // Why: only unknown flip-only options are actions; once we have a tracked
  // baseline the UI can show absolute On/Off without inventing a start state.
  return isFlipOnlyMidSession(apply.midSession) && !tracked ? { type: 'toggle-command' } : undefined
}

function optionDescriptor(args: {
  option: CatalogOption
  tracked: TrackedNativeChatSessionOption | undefined
  mode: NativeChatSessionOptionMode
  modelIsCliDefault: boolean
  composedModelApply: AgentSessionOptionCatalog['modelApply']
}): SessionOptionDescriptor | null {
  const { option, tracked, mode, modelIsCliDefault, composedModelApply } = args
  const action = actionForApply(option.apply, tracked, mode)
  const settable = settableState({ mode, apply: option.apply, composedModelApply })
  // Why: the launch only emits `values[id] ?? defaultValue` alongside a model flag, so
  // a draft names this option's value exactly when a model was picked. Under the CLI's
  // own default no flag is sent at all, and the CLI's unstated choice is not ours to name.
  const showDefault = mode === 'draft' && !tracked && !modelIsCliDefault
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
      ...settable,
      ...(action ? { action } : {})
    }
  }
  const currentValue =
    typeof tracked?.value === 'boolean'
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
      type: 'boolean',
      ...(currentValue === undefined ? {} : { currentValue })
    },
    valueSource,
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

/** The snapshot's non-model descriptors in display order. Shared so the two
 *  platforms' option pills can never disagree about ordering. */
export function sortNativeChatSessionOptions(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return snapshot
    .filter((descriptor) => descriptor.category !== 'model')
    .sort((left, right) => {
      const leftOrder = CATEGORY_ORDER[left.category ?? ''] ?? 3
      const rightOrder = CATEGORY_ORDER[right.category ?? ''] ?? 3
      return leftOrder - rightOrder
    })
}

/**
 * Why: the tracked model can sit outside the active list — a persisted default,
 * or an alias this host's CLI no longer lists. Keeping a row for it preserves
 * the labelled selection and the model's own options instead of blanking both.
 * Shared so mobile satisfies the same caller contract the desktop surface does.
 */
export function withTrackedNativeChatModel(
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  record: NativeChatSessionOptionRecord
): CatalogModel[] {
  const trackedId = typeof record.model?.value === 'string' ? record.model.value : null
  if (!trackedId || models.some((model) => model.id === trackedId)) {
    return [...models]
  }
  const seeded = catalog.models.find((model) => model.id === trackedId)
  return [...models, seeded ?? { id: trackedId, label: trackedId, options: [] }]
}

/** Why: no tracked model means no `-m` was ever emitted, so the CLI is running its
 *  own default — nameable only for a catalog that proves the seed states it. */
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

/** The model the picker is showing, tracked or CLI default. Shared so applying an
 *  option resolves the same row the snapshot rendered it under. */
export function resolveEffectiveNativeChatModelId(
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  record: NativeChatSessionOptionRecord
): string | null {
  const trackedModelId = typeof record.model?.value === 'string' ? record.model.value : null
  return trackedModelId ?? cliDefaultModelId(catalog, models, trackedModelId)
}

export function buildNativeChatSessionOptionSnapshot(args: {
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  record: NativeChatSessionOptionRecord
  mode: NativeChatSessionOptionMode
  modelLabel: string
}): SessionOptionDescriptor[] {
  const { catalog, models, record, mode, modelLabel } = args
  if (models.length === 0) {
    return []
  }
  const modelTracked = record.model
  // Why: callers reconcile the tracked model into `models` (see
  // withTrackedNativeChatModel), so every listed row is a real choice and the
  // trigger never shows a value without one.
  const modelChoices = models.map(({ id, label, description }) => ({
    value: id,
    label,
    ...(description ? { description } : {})
  }))
  const trackedModelId = typeof modelTracked?.value === 'string' ? modelTracked.value : null
  const defaultModelId = cliDefaultModelId(catalog, models, trackedModelId)
  const effectiveModelId = trackedModelId ?? defaultModelId
  const modelAction = actionForApply(catalog.modelApply, modelTracked, mode)
  const snapshot: SessionOptionDescriptor[] = [
    {
      id: 'model',
      label: modelLabel,
      category: 'model',
      kind: {
        type: 'select',
        ...(effectiveModelId ? { currentValue: effectiveModelId } : {}),
        choices: modelChoices
      },
      valueSource: modelTracked?.source ?? (defaultModelId ? 'default' : 'unknown'),
      ...settableState({ mode, apply: catalog.modelApply }),
      ...(modelAction ? { action: modelAction } : {})
    }
  ]
  if (!effectiveModelId) {
    return snapshot
  }
  const model = models.find((candidate) => candidate.id === effectiveModelId)
  const trackedValues = record.valuesByModel[effectiveModelId] ?? {}
  for (const option of model?.options ?? []) {
    const descriptor = optionDescriptor({
      option,
      tracked: trackedValues[option.id],
      mode,
      modelIsCliDefault: effectiveModelId === defaultModelId,
      composedModelApply: catalog.modelApply
    })
    if (descriptor) {
      snapshot.push(descriptor)
    }
  }
  return snapshot
}
