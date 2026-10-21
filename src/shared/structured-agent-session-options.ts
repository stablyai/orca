import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog'
import { discoveredModel } from './structured-agent-session-discovered-model'
import {
  createStructuredAgentSessionOptionRecord,
  replaceStructuredAgentSessionAnsweredValues,
  type StructuredAgentSessionOptionRecord
} from './structured-agent-session-option-state'
import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  STRUCTURED_LAUNCH_SEED_OPTION_IDS
} from './native-chat-session-option-defaults'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import {
  structuredAgentSessionDescribedModel,
  structuredAgentSessionShownModel
} from './structured-agent-session-option-snapshot'
import type { SessionOptionValue } from './native-chat-session-options'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from './agent-session-wire'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

export {
  canSetStructuredAgentSessionOption,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-option-snapshot'

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
  /** The rows of a live answer its agent's own listing names; a row outside them is the chat's
   *  own model, which no list describes. Absent from an older host. */
  verifiedModelIds?: readonly string[]
  record: StructuredAgentSessionOptionRecord
  /** The last answer came from a host that marks no defaults, whose own tier rule it shows. */
  olderHost?: true
  /** A resumed chat names the default its host marks but never sends it: its next start runs the
   *  agent's own. A new chat sends the default it shows, so its first send pins it. */
  defaultsUnsent?: true
  /** The permission mode the host or launch last stated; null shows no picker. */
  permissionMode: string | null
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
    record: createStructuredAgentSessionOptionRecord(agent),
    permissionMode: null,
    pendingId: null
  }
}

/** The host answered with no list (none saved, a failed read, or an older host): the built-in
 *  list becomes usable, still naming nothing until a host or session list does. */
export function settleStructuredAgentSessionBuiltinCatalog(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  return state.catalogSource === 'seed' ? { ...state, catalogSource: 'builtin' } : state
}

function isListedModelRow(row: unknown): row is { id: string } {
  return (
    typeof row === 'object' &&
    row !== null &&
    'id' in row &&
    typeof row.id === 'string' &&
    'efforts' in row &&
    Array.isArray(row.efforts)
  )
}

/** The ids a finished listing names; undefined for one still running, failed, empty or malformed. */
export function finishedListingIds(catalog: AgentSessionModelCatalogResult): string[] | undefined {
  const rows: unknown = catalog.origin === 'unknown' ? null : catalog.models
  return Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(isListedModelRow) &&
    !catalog.listingInProgress &&
    !catalog.unavailable
    ? rows.map((row) => row.id)
    : undefined
}

/**
 * Applies the host's stored model catalog: models only, no current selection
 * and no record writes, so nothing here reads as a committed value — the pick
 * stays provisional until a live options result confirms it. A live catalog
 * is never replaced by this.
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
  result: AgentSessionOptionsResult,
  /** Whether this view started the chat, which runs the default it shows until its first send.
   *  Absent reads as a chat it did not start, which never names a default as its own. */
  launch: { newLaunch: boolean } = { newLaunch: false }
): StructuredAgentSessionOptionState {
  const { current } = result
  // A value the host supplied from a catalog default is context for the picker, not the chat's own.
  replaceStructuredAgentSessionAnsweredValues(
    state.record,
    {
      ...(current.model ? { model: current.model } : {}),
      ...(current.effort ? { effort: current.effort } : {}),
      ...(current.fastMode !== undefined ? { fastMode: current.fastMode } : {}),
      ...(current.serviceTier ? { serviceTier: current.serviceTier } : {})
    },
    (id) =>
      current.defaulted?.some((key) => key === id)
        ? 'default'
        : current.confirmed?.includes(id)
          ? 'reported'
          : 'dispatched'
  )
  return {
    ...state,
    catalog: structuredAgentSessionOptionCatalog(seed, result),
    catalogSource: 'live',
    olderHost: current.defaulted === undefined ? true : undefined,
    defaultsUnsent: current.defaulted !== undefined && !launch.newLaunch ? true : undefined,
    verifiedModelIds: result.listedModelIds?.length ? result.listedModelIds : undefined,
    permissionMode: result.current.permissionMode ?? null
  }
}

/** The model a pick's other values were chosen under: the chat's own, else the default shown. */
function structuredAgentSessionControlsModelId(
  state: StructuredAgentSessionOptionState
): string | null {
  return state.catalog
    ? structuredAgentSessionShownModel(state.catalog, state.catalog.models, state.record)
        .controlsModelId
    : null
}

export function commitStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: string
): StructuredAgentSessionOptionState {
  if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    return { ...state, permissionMode: value, pendingId: null }
  }
  if (!state.catalog) {
    return state
  }
  const decoded = decodeStructuredAgentSessionOptionValue(id, value)
  if (decoded === null) {
    return { ...state, pendingId: null }
  }
  // Each value is the chat's own: a model pick leaves the others for the host to reconcile.
  state.record.values[id] = { value: decoded, source: 'dispatched' }
  return { ...state, pendingId: null }
}

/** Whether a pick of `modelId` held before launch keeps another held value (decoded or encoded):
 *  no host exists yet to reconcile it, so only what the model's controls offer stays. A model the
 *  list does not describe keeps every value, since nothing says what it takes. */
export function structuredAgentSessionModelOffers(
  state: Pick<StructuredAgentSessionOptionState, 'catalog' | 'verifiedModelIds'>,
  modelId: string,
  id: string,
  value: SessionOptionValue
): boolean {
  const model = structuredAgentSessionDescribedModel(state, modelId)
  if (id === 'model' || id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID || !model) {
    return true
  }
  const option = model.options.find((entry) => entry.id === id)
  return option?.kind.type === 'select'
    ? option.kind.choices.some((choice) => choice.value === value)
    : option !== undefined
}

export function commitStructuredAgentSessionOptionValues(
  state: StructuredAgentSessionOptionState,
  values: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  let next = state
  for (const id of STRUCTURED_LAUNCH_OPTION_IDS) {
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
      : structuredAgentSessionControlsModelId(state)
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
