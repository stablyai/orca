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
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import { STRUCTURED_LAUNCH_HELD_OPTION_IDS } from './native-chat-session-option-defaults'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  commitAgentSessionPermissionMode,
  parseAgentSessionPermissionModes,
  type AgentSessionPermissionModes
} from './agent-chat-permission-mode'
import type { SessionOptionDescriptor, SessionOptionValue } from './native-chat-session-options'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from './agent-session-wire'
import { decodeStructuredAgentSessionOptionValue } from './structured-agent-session-option-codec'

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
  if (result.current.model && !models.some((model) => model.id === result.current.model)) {
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
  /** What produced `catalog`; a weaker source never replaces a stronger one. `seed` is the
   *  built-in list before the host answered (shown as the quiet placeholder); `builtin` is the
   *  same list once the host said it has none, usable but naming nothing the host may replace. */
  catalogSource: 'seed' | 'builtin' | 'host' | 'live' | null
  record: NativeChatSessionOptionRecord
  /** The chat's permission mode, apart from the per-model record so a model switch never drops
   *  it; null while the host has not said it offers the picker. */
  permission: AgentSessionPermissionModes | null
  pendingId: string | null
}

/** With `seedCatalog`, the state holds the static seed from the first frame, but the picker shows
 *  the quiet placeholder until the host answers; every later source only upgrades it. */
export function createStructuredAgentSessionOptionState(
  agent = 'codex',
  seedCatalog?: AgentSessionOptionCatalog | null
): StructuredAgentSessionOptionState {
  return {
    catalog: seedCatalog ?? null,
    catalogSource: seedCatalog ? 'seed' : null,
    record: createNativeChatSessionOptionRecord(agent),
    permission: null,
    pendingId: null
  }
}

/** A fence or session reset: a host answer is the account's, not the fence's, so the same
 *  session keeps it rather than fall back to the placeholder. */
export function reseedStructuredAgentSessionOptionState(
  previous: StructuredAgentSessionOptionState,
  seeded: StructuredAgentSessionOptionState,
  sameSession: boolean
): StructuredAgentSessionOptionState {
  return sameSession && (previous.catalogSource === 'host' || previous.catalogSource === 'builtin')
    ? { ...seeded, catalog: previous.catalog, catalogSource: previous.catalogSource }
    : seeded
}

/** The host answered with no list (none saved, a failed read, or an older host): the built-in
 *  list becomes usable, still naming nothing until a host or session list does. */
export function settleStructuredAgentSessionBuiltinCatalog(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  return state.catalogSource === 'seed' ? { ...state, catalogSource: 'builtin' } : state
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
  options: { newLaunch: boolean }
): StructuredAgentSessionOptionState {
  if (state.catalogSource === 'live') {
    return state
  }
  const models =
    catalog.origin === 'unknown'
      ? []
      : catalog.models.map((model) =>
          discoveredModel(model, catalog.fastModeSupport?.supported === true)
        )
  if (catalog.origin === 'unknown' || models.length === 0) {
    return settleStructuredAgentSessionBuiltinCatalog(state)
  }
  // The host says whether its listed default is what this launch runs; an older host never says,
  // so the client's own knowledge of the agent stands in. A reopened chat may keep its own model.
  const namesDefault =
    options.newLaunch &&
    (catalog.listingNamesConfiguredModel ?? seed.hostListingNamesConfiguredModel === true)
  return {
    ...state,
    // `isDefault` came from a real listing, so a launch's CLI default is nameable —
    // as a provisional `default`-source value, never a confirmed one.
    catalog: {
      ...seed,
      models,
      ...(namesDefault ? { defaultModelIsCliDefault: true } : {})
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
    clearTrackedSessionOption(state.record, result.current.model ?? null, 'fastMode')
  }
  applyNativeChatReportedSessionOptions(
    state.record,
    {
      ...(result.current.model ? { model: result.current.model } : {}),
      ...(result.current.effort ? { effort: result.current.effort } : {}),
      ...(result.current.fastMode !== undefined ? { fastMode: result.current.fastMode } : {})
    },
    result.current.confirmed ?? []
  )
  return {
    ...state,
    catalog: structuredAgentSessionOptionCatalog(seed, result),
    catalogSource: 'live',
    permission: parseAgentSessionPermissionModes(result.permissionModes)
  }
}

/** Before the host answers, or an agent with no list reports, the quiet model pill: never
 *  pickable, so displaying it can never become a launch pick. */
const PROVIDER_DEFAULT_MODEL_PLACEHOLDER: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: { type: 'select', choices: [] },
  valueSource: 'unknown',
  transport: 'agent-session',
  settable: false,
  disabledReason: 'available-after-session-start'
}

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  if (!state.catalog) {
    return []
  }
  // Until the host answers, the built-in list would paint a label its list may replace.
  if (state.catalogSource === 'seed') {
    return [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
  }
  const snapshot = buildNativeChatSessionOptionSnapshot({
    catalog: state.catalog,
    // A seeded default can name a model the static seed does not list yet.
    models: withTrackedNativeChatModel(state.catalog, state.catalog.models, state.record),
    record: state.record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'agent-session'
  })
  return snapshot.length > 0 || state.catalogSource === 'live'
    ? snapshot
    : [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
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
  if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    return (
      state.pendingId === null &&
      typeof value === 'string' &&
      state.permission?.supported.some((mode) => mode === value) === true
    )
  }
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
  if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    const permission = commitAgentSessionPermissionMode(state.permission, state.record.agent, value)
    return { ...state, permission, pendingId: null }
  }
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
  for (const id of STRUCTURED_LAUNCH_HELD_OPTION_IDS) {
    const value = values[id]
    if (value !== undefined) {
      next = commitStructuredAgentSessionOption(next, id, value)
    }
  }
  return next
}
