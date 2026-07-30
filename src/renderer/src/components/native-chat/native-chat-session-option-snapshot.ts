import {
  findCatalogModel,
  type AgentSessionOptionCatalog,
  type CatalogMidSessionApply,
  type CatalogModel,
  type CatalogOption
} from '../../../../shared/agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import type {
  NativeChatSessionOptionRecord,
  TrackedNativeChatSessionOption
} from './native-chat-session-option-cache'
import { isFlipOnlyMidSession } from './native-chat-session-option-flip'
import { translate } from '@/i18n/i18n'

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
  const midSession = args.apply.midSession
  if (args.apply.composedIntoModel && args.composedModelApply?.midSession?.kind === 'command') {
    return { settable: true }
  }
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
  if (isFlipOnlyMidSession(apply.midSession) && !tracked) {
    return { type: 'toggle-command' }
  }
  return undefined
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

export function buildNativeChatSessionOptionSnapshot(args: {
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  record: NativeChatSessionOptionRecord
  mode: NativeChatSessionOptionMode
}): SessionOptionDescriptor[] {
  const { catalog, models, record, mode } = args
  const modelTracked = record.model
  const modelChoices = choiceWithCurrent(
    models.map(({ id, label, description }) => ({
      value: id,
      label,
      ...(description ? { description } : {})
    })),
    modelTracked
  )
  const modelSettable = settableState({ mode, apply: catalog.modelApply })
  const modelAction = actionForApply(catalog.modelApply, modelTracked, mode)
  const snapshot: SessionOptionDescriptor[] = [
    {
      id: 'model',
      label: translate('components.native-chat.composer.model', 'Model'),
      category: 'model',
      kind: {
        type: 'select',
        ...(typeof modelTracked?.value === 'string' ? { currentValue: modelTracked.value } : {}),
        choices: modelChoices
      },
      valueSource: modelTracked?.source ?? 'unknown',
      ...modelSettable,
      ...(modelAction ? { action: modelAction } : {})
    }
  ]
  if (typeof modelTracked?.value !== 'string') {
    return snapshot
  }
  const model = findCatalogModel({ ...catalog, models: [...models] }, modelTracked.value)
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

export function flattenNativeChatSessionOptionRecord(
  record: NativeChatSessionOptionRecord,
  modelId: string
): Record<string, SessionOptionValue> {
  return {
    model: modelId,
    ...Object.fromEntries(
      Object.entries(record.valuesByModel[modelId] ?? {}).map(([id, tracked]) => [
        id,
        tracked.value
      ])
    )
  }
}
