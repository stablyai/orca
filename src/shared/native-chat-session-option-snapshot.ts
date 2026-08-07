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
  composedModelApply: AgentSessionOptionCatalog['modelApply']
}): SessionOptionDescriptor | null {
  const { option, tracked, mode, composedModelApply } = args
  const action = actionForApply(option.apply, tracked, mode)
  const settable = settableState({ mode, apply: option.apply, composedModelApply })
  if (option.kind.type === 'select') {
    const choices = choiceWithCurrent(option.kind.choices, tracked)
    if (choices.length <= 1) {
      return null
    }
    return {
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
      kind: {
        type: 'select',
        ...(typeof tracked?.value === 'string' ? { currentValue: tracked.value } : {}),
        choices
      },
      valueSource: tracked?.source ?? 'unknown',
      ...settable,
      ...(action ? { action } : {})
    }
  }
  return {
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.category ? { category: option.category } : {}),
    kind: {
      type: 'boolean',
      ...(typeof tracked?.value === 'boolean' ? { currentValue: tracked.value } : {})
    },
    valueSource: tracked?.source ?? 'unknown',
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
  const modelAction = actionForApply(catalog.modelApply, modelTracked, mode)
  const snapshot: SessionOptionDescriptor[] = [
    {
      id: 'model',
      label: modelLabel,
      category: 'model',
      kind: {
        type: 'select',
        ...(typeof modelTracked?.value === 'string' ? { currentValue: modelTracked.value } : {}),
        choices: modelChoices
      },
      valueSource: modelTracked?.source ?? 'unknown',
      ...settableState({ mode, apply: catalog.modelApply }),
      ...(modelAction ? { action: modelAction } : {})
    }
  ]
  if (typeof modelTracked?.value !== 'string') {
    return snapshot
  }
  const model = models.find((candidate) => candidate.id === modelTracked.value)
  const trackedValues = record.valuesByModel[modelTracked.value] ?? {}
  for (const option of model?.options ?? []) {
    const descriptor = optionDescriptor({
      option,
      tracked: trackedValues[option.id],
      mode,
      composedModelApply: catalog.modelApply
    })
    if (descriptor) {
      snapshot.push(descriptor)
    }
  }
  return snapshot
}
