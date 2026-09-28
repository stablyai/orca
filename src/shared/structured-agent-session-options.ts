import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog'
import {
  buildNativeChatSessionOptionSnapshot,
  resolveEffectiveNativeChatModelId,
  withTrackedNativeChatModel
} from './native-chat-session-option-snapshot'
import {
  applyNativeChatReportedSessionOptions,
  clearTrackedSessionOption,
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat-session-option-defaults'
import type { SessionOptionDescriptor, SessionOptionValue } from './native-chat-session-options'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from './agent-session-wire'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

function effortOption(model: AgentSessionOptionsResult['models'][number]): CatalogOption | null {
  if (model.efforts.length <= 1) {
    return null
  }
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: model.efforts,
      defaultValue: model.defaultEffort ?? model.efforts[0]!.value,
      ...(model.defaultEffort ? { defaultIsCliDefault: true as const } : {})
    },
    apply: { midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` } }
  }
}

function fastModeOption(): CatalogOption {
  return {
    id: 'fastMode',
    label: 'Fast mode',
    category: 'mode',
    kind: { type: 'boolean', defaultValue: false },
    apply: {}
  }
}

function discoveredModel(
  model: AgentSessionOptionsResult['models'][number],
  sessionSupportsFastMode: boolean
): CatalogModel {
  const effort = effortOption(model)
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    options: [
      ...(effort ? [effort] : []),
      ...(sessionSupportsFastMode && model.supportsFastMode === true ? [fastModeOption()] : [])
    ]
  }
}

export function structuredAgentSessionOptionCatalog(
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult
): AgentSessionOptionCatalog {
  const models: CatalogModel[] = result.models.map((model) =>
    discoveredModel(model, result.fastModeSupport?.supported === true)
  )
  if (!models.some((model) => model.id === result.current.model)) {
    models.push({
      id: result.current.model,
      label: result.current.model,
      options: seed.unknownModelOptions ?? []
    })
  }
  return { ...seed, models, defaultModelIsCliDefault: true }
}

export type StructuredAgentSessionOptionState = {
  catalog: AgentSessionOptionCatalog | null
  /** What produced `catalog`; a weaker source never replaces a stronger one. */
  catalogSource: 'seed' | 'host' | 'live' | null
  record: NativeChatSessionOptionRecord
  pendingId: string | null
}

/** With `seedCatalog`, the picker renders (and accepts picks against) the
 *  static seed from the first frame; every later source only upgrades it. */
export function createStructuredAgentSessionOptionState(
  agent = 'codex',
  seedCatalog?: AgentSessionOptionCatalog | null
): StructuredAgentSessionOptionState {
  return {
    catalog: seedCatalog ?? null,
    catalogSource: seedCatalog ? 'seed' : null,
    record: createNativeChatSessionOptionRecord(agent),
    pendingId: null
  }
}

/**
 * What the picker shows before the host has confirmed this session's values:
 * `seed` (the selection a launch seeds) stands in until the record names a
 * model, and `held` picks outrank both until the host settles them. Both show
 * as `dispatched`; derived on every read, never written into the record.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const seeded = seed !== undefined && state.record.model === undefined
  if (!state.catalog || (!seeded && Object.keys(held).length === 0)) {
    return state
  }
  let view: StructuredAgentSessionOptionState = {
    ...state,
    record: cloneNativeChatSessionOptionRecord(state.record)
  }
  if (seeded) {
    view = commitStructuredAgentSessionOptionValues(view, seed)
  }
  return { ...commitStructuredAgentSessionOptionValues(view, held), pendingId: state.pendingId }
}

/**
 * Applies the host's stored model catalog: models only, no current selection
 * and no record writes, so nothing here reads as a committed value — the pick
 * stays provisional until a live options result confirms it. A live catalog
 * is never downgraded by this.
 */
export function applyStructuredAgentSessionModelCatalog(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  catalog: AgentSessionModelCatalogResult,
  options: { namesDefault: boolean }
): StructuredAgentSessionOptionState {
  if (state.catalogSource === 'live' || catalog.origin === 'unknown') {
    return state
  }
  const models = catalog.models.map((model) =>
    discoveredModel(model, catalog.fastModeSupport?.supported === true)
  )
  if (models.length === 0) {
    return state
  }
  return {
    ...state,
    // `isDefault` came from a real listing, so a launch's CLI default is nameable —
    // as a provisional `default`-source value, never a confirmed one.
    catalog: {
      ...seed,
      models,
      ...(options.namesDefault ? { defaultModelIsCliDefault: true } : {})
    },
    catalogSource: 'host'
  }
}

export function applyStructuredAgentSessionOptions(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult
): StructuredAgentSessionOptionState {
  if (result.current.fastMode === undefined) {
    clearTrackedSessionOption(state.record, result.current.model, 'fastMode')
  }
  applyNativeChatReportedSessionOptions(
    state.record,
    {
      model: result.current.model,
      ...(result.current.effort ? { effort: result.current.effort } : {}),
      ...(result.current.fastMode !== undefined ? { fastMode: result.current.fastMode } : {})
    },
    result.current.confirmed ?? []
  )
  return {
    ...state,
    catalog: structuredAgentSessionOptionCatalog(seed, result),
    catalogSource: 'live'
  }
}

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  if (!state.catalog) {
    return []
  }
  return buildNativeChatSessionOptionSnapshot({
    catalog: state.catalog,
    // A seeded default can name a model the static seed does not list yet.
    models: withTrackedNativeChatModel(state.catalog, state.catalog.models, state.record),
    record: state.record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'agent-session'
  })
}

/** No launch holds a pick and no fence can carry one yet, so the picker only shows. */
export function lockedStructuredAgentSessionOptionSnapshot(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) => ({
    ...descriptor,
    settable: false,
    disabledReason: 'available-after-session-start'
  }))
}

export function canSetStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: SessionOptionValue
): boolean {
  const descriptor = structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === id)
  return Boolean(
    state.catalog &&
    state.pendingId === null &&
    ((typeof value === 'string' &&
      descriptor?.kind.type === 'select' &&
      descriptor.kind.choices.some((choice) => choice.value === value)) ||
      (typeof value === 'boolean' && descriptor?.kind.type === 'boolean'))
  )
}

export function commitStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: string
): StructuredAgentSessionOptionState {
  if (!state.catalog) {
    return state
  }
  const effectiveModel = resolveEffectiveNativeChatModelId(
    state.catalog,
    state.catalog.models,
    state.record
  )
  const decoded = decodeStructuredAgentSessionOptionValue(id, value)
  if (decoded === null) {
    return { ...state, pendingId: null }
  }
  setTrackedSessionOption(state.record, id, decoded, 'dispatched', effectiveModel)
  return { ...state, pendingId: null }
}

export function commitStructuredAgentSessionOptionValues(
  state: StructuredAgentSessionOptionState,
  values: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  let next = state
  for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS) {
    const value = values[id]
    if (value !== undefined) {
      next = commitStructuredAgentSessionOption(next, id, value)
    }
  }
  return next
}

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: SessionOptionValue
}

/**
 * The picks a mutation must remember so the next launch starts where the user left off.
 * Keyed off the same ids the launch seed reads back, so a pick this surface cannot
 * re-seed is never written.
 *
 * Model and effort travel as a pair: a launch resolves a stored effort only under a
 * stored model, so an effort-only pick adopts the model it was chosen against. Values
 * come from what the provider committed, not what was requested — it reconciles an
 * effort the newly selected model cannot run before reporting back.
 *
 * `state` may still be pre-commit: a changed model arrives in `committed`, and an
 * unchanged one is already what the record tracks, so neither reading depends on the
 * commit having landed.
 */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>
): StructuredSessionOptionPick[] {
  if (!state.catalog) {
    return []
  }
  const committedModel = committed.model
  const modelId =
    typeof committedModel === 'string' && committedModel.trim()
      ? committedModel
      : resolveEffectiveNativeChatModelId(state.catalog, state.catalog.models, state.record)
  if (!modelId) {
    return []
  }
  return STRUCTURED_LAUNCH_SEED_OPTION_IDS.flatMap((optionId) => {
    const value = committed[optionId]
    if (value === undefined) {
      return []
    }
    const decoded = decodeStructuredAgentSessionOptionValue(optionId, value)
    return decoded === null ||
      (typeof decoded === 'string' && !decoded.trim()) ||
      encodeStructuredAgentSessionOptionValue(optionId, decoded) === null
      ? []
      : [{ modelId, optionId, value: decoded }]
  })
}
