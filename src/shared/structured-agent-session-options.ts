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
import { usesInstalledAgentModelCatalog } from './agent-model-catalog-ownership'
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
  /** Catalog provenance, not current-child eligibility: seed stays a placeholder until the host answers;
   * builtin then enables the static list without naming a model the host may replace. */
  catalogSource: 'seed' | 'builtin' | 'host' | 'live' | null
  /** Live-answer IDs verified by the agent’s listing; extra rows name the chat’s own model, not listed capabilities. Old hosts omit this. */
  verifiedModelIds?: readonly string[]
  record: StructuredAgentSessionOptionRecord
  /** The last answer came from a host that marks no defaults, whose own tier rule it shows. */
  olderHost?: true
  /** Resumed chats show host defaults without sending them; new chats pin their shown default on first send. */
  defaultsUnsent?: true
  /** The permission mode the host or launch last stated; null shows no picker. */
  permissionMode: string | null
  reportedPermissionMode?: string | null
  permissionOwnSupported?: boolean | null
  pendingId: string | null
  listingInProgress?: boolean
  fastModeRestricted?: boolean
}

/** Install a static seed immediately, but show the placeholder until the host answers; later sources only upgrade it. */
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

/** A missing/failed/old-host list enables built-in controls but names no model until a host/session list does. */
export function settleStructuredAgentSessionBuiltinCatalog(
  state: StructuredAgentSessionOptionState,
  listingInProgress = state.listingInProgress
): StructuredAgentSessionOptionState {
  const catalogSource = state.catalogSource === 'seed' ? 'builtin' : state.catalogSource
  return catalogSource === state.catalogSource && state.listingInProgress === listingInProgress
    ? state
    : { ...state, catalogSource, listingInProgress }
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

/** Install models only; no record writes or committed picks until an options result confirms them. */
export function applyStructuredAgentSessionModelCatalog(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  catalog: AgentSessionModelCatalogResult,
  options: { newLaunch: boolean; coherentCatalog?: boolean }
): StructuredAgentSessionOptionState {
  const installed = usesInstalledAgentModelCatalog(state.record.agent, options.coherentCatalog)
  const listingInProgress = installed && catalog.listingInProgress === true
  if (Boolean(state.listingInProgress) !== listingInProgress) {
    state = { ...state, listingInProgress }
  }
  if (state.catalogSource === 'live' && !installed) {
    return state
  }
  const models =
    catalog.origin === 'unknown'
      ? []
      : catalog.models.map((model) =>
          discoveredModel(model, catalog.fastModeSupport?.supported === true)
        )
  if (catalog.origin === 'unknown' || (!installed && models.length === 0)) {
    return settleStructuredAgentSessionBuiltinCatalog(state)
  }
  // Only new launches may name the listing default; use host evidence, or agent knowledge for old hosts. Reopened chats may retain another model.
  const namesDefault =
    options.newLaunch &&
    (catalog.listingNamesConfiguredModel ?? seed.hostListingNamesConfiguredModel === true)
  return {
    ...state,
    // Real-listing defaults are nameable but provisional, never confirmed picks.
    catalog: {
      ...(state.catalogSource === 'live' ? (state.catalog ?? seed) : seed),
      models,
      ...(namesDefault ? { defaultModelIsCliDefault: true } : {})
    },
    ...(installed ? { verifiedModelIds: finishedListingIds(catalog) } : {}),
    catalogSource: state.catalogSource === 'live' ? 'live' : 'host'
  }
}

export function applyStructuredAgentSessionOptions(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult,
  /** Absent means this view did not start the chat, so listing defaults never become its own values. */
  launch: { newLaunch: boolean; coherentCatalog?: boolean } = { newLaunch: false }
): StructuredAgentSessionOptionState {
  const { current } = result
  const installed = usesInstalledAgentModelCatalog(state.record.agent, launch.coherentCatalog)
  // Catalog defaults supply picker context without claiming the chat chose them.
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
    catalog: installed ? state.catalog : structuredAgentSessionOptionCatalog(seed, result),
    fastModeRestricted:
      installed &&
      result.fastModeSupport?.supported === false &&
      result.fastModeSupport.reason !== 'model-not-supported',
    catalogSource: installed && state.catalogSource === 'seed' ? 'seed' : 'live',
    olderHost: current.defaulted === undefined ? true : undefined,
    defaultsUnsent: current.defaulted !== undefined && !launch.newLaunch ? true : undefined,
    verifiedModelIds: installed
      ? state.verifiedModelIds
      : result.listedModelIds?.length
        ? result.listedModelIds
        : undefined,
    permissionMode: result.current.permissionMode ?? null,
    reportedPermissionMode: result.current.reportedPermissionMode
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
    return { ...state, permissionMode: value, reportedPermissionMode: undefined, pendingId: null }
  }
  if (!state.catalog) {
    return state
  }
  const decoded = decodeStructuredAgentSessionOptionValue(id, value)
  if (decoded === null) {
    return { ...state, pendingId: null }
  }
  // Keep other picks after a model change; the host reconciles independent values.
  state.record.values[id] = { value: decoded, source: 'dispatched' }
  return { ...state, pendingId: null }
}

/** Before launch no host can reconcile held picks; keep only values offered by the model’s controls.
 * An undescribed model preserves all values because no listing can disprove them. */
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

/** Persist only reseedable IDs, using provider-committed values after reconciliation. Effort-only picks adopt their controls’ model
 * because launch reads effort only under a stored model. Pre-commit state is valid: committed supplies changed model, record supplies unchanged model. */
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
