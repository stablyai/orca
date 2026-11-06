import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { discoveredModel } from './structured-agent-session-discovered-model'
import {
  createStructuredAgentSessionOptionRecord,
  replaceStructuredAgentSessionAnsweredValues,
  type StructuredAgentSessionOptionRecord
} from './structured-agent-session-option-state'
import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  STRUCTURED_LAUNCH_SEED_OPTION_IDS
} from '../../native-chat/input/native-chat-session-option-defaults'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../agent-launch/permissions/agent-chat-permission-mode'
import {
  usesInstalledAgentModelCatalog,
  usesModelSpecificAcpEfforts
} from './agent-model-catalog-ownership'
import {
  fillUnknownCatalogEfforts,
  enrichStructuredAgentEfforts
} from './agent-session-model-efforts'
import { structuredAgentSessionRememberedPickModel } from './structured-agent-session-remembered-pick-model'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import type {
  AgentSessionAcceptedInputSources,
  AgentSessionOptionsResult
} from './agent-session-options-result'
import { labelFromModelId } from '../../model-id-label'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import { listingVerifiedModelIds } from './structured-agent-session-listing-verified-ids'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

export function structuredAgentSessionOptionCatalog(
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult,
  agent: StructuredAgentSessionOptionRecord['agent']
): AgentSessionOptionCatalog {
  const models: CatalogModel[] = result.models.map((model) =>
    discoveredModel(model, result.fastModeSupport?.supported === true, agent)
  )
  if (result.current.model && !models.some((model) => model.id === result.current.model)) {
    models.push({
      id: result.current.model,
      label: labelFromModelId(result.current.model),
      description: result.current.model,
      options: seed.unknownModelOptions ?? []
    })
  }
  return { ...seed, models, defaultModelIsCliDefault: true }
}

export type StructuredAgentSessionOptionState = {
  catalog: AgentSessionOptionCatalog | null
  /** Catalog provenance, independent of known input: seed offers no replacement models;
   * builtin enables static rows only after unavailable discovery. */
  catalogSource: 'seed' | 'builtin' | 'host' | 'live' | null
  /** Live-answer IDs verified by the agent’s listing; extra rows name the chat’s own model, not listed capabilities. Old hosts omit this. */
  verifiedModelIds?: readonly string[]
  record: StructuredAgentSessionOptionRecord
  optionsAnswerPresent?: true
  sessionNeverStarted?: boolean
  /** Latest catalog observation, separate from static old-host seed knowledge. */
  catalogNamesConfiguredModel?: boolean
  acceptedInputSources?: Partial<
    Record<keyof AgentSessionAcceptedInputSources, 'saved' | 'seeded' | 'policy' | 'picked'>
  >
  /** The last answer came from a host that marks no defaults, whose own tier rule it shows. */
  olderHost?: true
  /** Resumed chats show host defaults without sending them; new chats pin their shown default on first send. */
  defaultsUnsent?: true
  /** The permission mode the host or launch last stated; null shows no picker. */
  permissionMode: string | null
  reportedPermissionMode?: string | null
  permissionOwnSupported?: boolean | null
  reportedModel?: string
  reportedEffort?: string
  /** The host is still listing models; it only keeps a seed from settling to built-in, since controls follow their data. */
  listingInProgress?: boolean
  fastModeRestricted?: boolean
}

/** Seed definitions supply geometry; only accepted input or host inventory can name a model. */
export function createStructuredAgentSessionOptionState(
  agent = 'codex',
  seedCatalog?: AgentSessionOptionCatalog | null
): StructuredAgentSessionOptionState {
  return {
    catalog: seedCatalog ?? null,
    catalogSource: seedCatalog ? 'seed' : null,
    record: createStructuredAgentSessionOptionRecord(agent),
    acceptedInputSources: {},
    permissionMode: null
  }
}

/** A missing/failed/old-host list enables built-in controls but names no model until a host/session list does. */
export function settleStructuredAgentSessionBuiltinCatalog(
  state: StructuredAgentSessionOptionState,
  listingInProgress = state.listingInProgress
): StructuredAgentSessionOptionState {
  const catalogSource =
    state.catalogSource === 'seed' && !listingInProgress ? 'builtin' : state.catalogSource
  return catalogSource === state.catalogSource && state.listingInProgress === listingInProgress
    ? state
    : { ...state, catalogSource, listingInProgress }
}

/** Install models only; no record writes or committed picks until an options result confirms them. */
export function applyStructuredAgentSessionModelCatalog(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  catalog: AgentSessionModelCatalogResult,
  options: { newLaunch: boolean; coherentCatalog?: boolean }
): StructuredAgentSessionOptionState {
  const installed = usesInstalledAgentModelCatalog(state.record.agent, options.coherentCatalog)
  const listingInProgress = catalog.listingInProgress === true
  const catalogNamesConfiguredModel =
    catalog.origin === 'unknown' || catalog.unavailable
      ? undefined
      : catalog.listingNamesConfiguredModel
  if (
    Boolean(state.listingInProgress) !== listingInProgress ||
    state.catalogNamesConfiguredModel !== catalogNamesConfiguredModel
  ) {
    state = { ...state, listingInProgress, catalogNamesConfiguredModel }
  }
  if (state.catalogSource === 'live' && !installed) {
    return enrichStructuredAgentEfforts(state, catalog)
  }
  const models =
    catalog.origin === 'unknown'
      ? []
      : catalog.models.map((model) =>
          discoveredModel(model, catalog.fastModeSupport?.supported === true, state.record.agent)
        )
  if (catalog.origin === 'unknown' || (!installed && models.length === 0)) {
    return settleStructuredAgentSessionBuiltinCatalog(state)
  }
  // Only new launches may name the listing default; use host evidence, or agent knowledge for old hosts. Reopened chats may retain another model.
  const namesDefault =
    options.newLaunch &&
    (catalog.listingNamesConfiguredModel ?? seed.hostListingNamesConfiguredModel === true)
  const verifiedModelIds = listingVerifiedModelIds(state.verifiedModelIds, catalog, models)
  return {
    ...state,
    // Real-listing defaults are nameable but provisional, never confirmed picks.
    catalog: {
      ...(state.catalogSource === 'live' ? (state.catalog ?? seed) : seed),
      models,
      ...(namesDefault ? { defaultModelIsCliDefault: true } : {})
    },
    ...(installed ? { verifiedModelIds } : {}),
    catalogSource: state.catalogSource === 'live' ? 'live' : 'host',
    acceptedInputSources: state.optionsAnswerPresent
      ? state.acceptedInputSources
      : {
          fastMode: 'policy',
          ...Object.fromEntries(
            Object.entries(state.acceptedInputSources ?? {}).filter(
              ([, source]) => source !== 'policy'
            )
          )
        }
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
  let acceptedInputSources = current.acceptedInputSources
  const policyEffort = acceptedInputSources?.effort === 'policy'
  if (policyEffort) {
    acceptedInputSources = { ...acceptedInputSources }
    delete acceptedInputSources.effort
  }
  const installed = usesInstalledAgentModelCatalog(state.record.agent, launch.coherentCatalog)
  const keepCatalog = installed || result.modelsKnown === false
  let answeredCatalog = structuredAgentSessionOptionCatalog(seed, result, state.record.agent)
  if (usesModelSpecificAcpEfforts(state.record.agent)) {
    answeredCatalog = {
      ...answeredCatalog,
      models: fillUnknownCatalogEfforts(answeredCatalog.models, state.catalog?.models ?? [])
    }
  }
  // Catalog defaults supply picker context without claiming the chat chose them.
  replaceStructuredAgentSessionAnsweredValues(
    state.record,
    {
      ...(current.model ? { model: current.model } : {}),
      ...(!policyEffort && current.effort ? { effort: current.effort } : {}),
      ...(current.fastMode !== undefined ? { fastMode: current.fastMode } : {}),
      ...(current.serviceTier ? { serviceTier: current.serviceTier } : {})
    },
    (id) =>
      current.defaulted?.some((key) => key === id)
        ? 'default'
        : current.confirmed?.includes(id)
          ? 'reported'
          : id === 'serviceTier' && current.defaulted !== undefined
            ? 'applied'
            : 'dispatched',
    state.record.agent === 'codex' && current.defaulted !== undefined
  )
  return {
    ...state,
    optionsAnswerPresent: true,
    sessionNeverStarted: result.sessionNeverStarted,
    reportedModel: current.reportedModel,
    reportedEffort: state.record.agent === 'pi' ? current.reportedEffort : undefined,
    catalog: keepCatalog ? state.catalog : answeredCatalog,
    fastModeRestricted:
      installed &&
      result.fastModeSupport?.supported === false &&
      result.fastModeSupport.reason !== 'model-not-supported',
    catalogSource:
      result.modelsKnown === false
        ? state.catalogSource === 'live'
          ? 'host'
          : state.catalogSource
        : installed && state.catalogSource === 'seed'
          ? 'seed'
          : 'live',
    acceptedInputSources,
    olderHost: current.defaulted === undefined ? true : undefined,
    defaultsUnsent: current.defaulted !== undefined && !launch.newLaunch ? true : undefined,
    verifiedModelIds: keepCatalog
      ? state.verifiedModelIds
      : result.listedModelIds?.length
        ? result.listedModelIds
        : undefined,
    permissionMode: result.current.permissionMode ?? null,
    reportedPermissionMode: result.current.reportedPermissionMode
  }
}

export function commitStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: string,
  origin: 'picked' | 'seeded' = 'picked'
): StructuredAgentSessionOptionState {
  if (id === 'model') {
    state = { ...state, reportedModel: undefined }
  }
  if (id === 'model' || id === 'effort') {
    state = { ...state, reportedEffort: undefined }
  }
  if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    return { ...state, permissionMode: value, reportedPermissionMode: undefined }
  }
  if (!state.catalog) {
    return state
  }
  const decoded = decodeStructuredAgentSessionOptionValue(id, value)
  if (decoded === null) {
    return state
  }
  // Keep other picks after a model change; the host reconciles independent values.
  state.record.values[id] = { value: decoded, source: 'dispatched' }
  return {
    ...state,
    acceptedInputSources:
      state.acceptedInputSources === undefined
        ? undefined
        : { ...state.acceptedInputSources, [id]: origin }
  }
}

export function commitStructuredAgentSessionOptionValues(
  state: StructuredAgentSessionOptionState,
  values: Readonly<Record<string, string>>,
  origin: 'picked' | 'seeded' = 'picked'
): StructuredAgentSessionOptionState {
  let next = state
  for (const id of STRUCTURED_LAUNCH_OPTION_IDS) {
    const value = values[id]
    if (value !== undefined) {
      next = commitStructuredAgentSessionOption(next, id, value, origin)
    }
  }
  return next
}

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: SessionOptionValue
  adoptModelAsLaunchDefault?: boolean
}

/** Persist only reseedable IDs, using provider-committed values after reconciliation. Effort-only picks adopt their controls’ model
 * because launch reads effort only under a stored model. Pre-commit state is valid: committed supplies changed model, record supplies unchanged model. */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>,
  existingChat = false
): StructuredSessionOptionPick[] {
  if (!state.catalog) {
    return []
  }
  const remembered = structuredAgentSessionRememberedPickModel(state, committed.model, existingChat)
  if (!remembered) {
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
      : [{ ...remembered, optionId, value: decoded }]
  })
}
