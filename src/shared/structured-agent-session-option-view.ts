import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import { cloneNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import {
  agentModelListNames,
  unlistedAgentModelReplacement,
  verifiedListReplacementRecord
} from './agent-session-model-fallback'

function catalogListsSeedModel(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>>
): boolean {
  const model = seed.model
  return model === undefined || agentModelListNames(state.catalog?.models ?? [], model)
}

/** The host's current list lacks this seed, so the host starts the chat on its replacement. */
function hostReplacesSeedModel(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>>
): boolean {
  return (
    state.catalogSource === 'host' &&
    unlistedAgentModelReplacement(
      state.catalog?.models ?? [],
      seed.model,
      state.hostModelReplacement
    ) !== null
  )
}

/** Shows what the host starts the chat on once its current list lacks the selection. */
function withVerifiedModelReplacement(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  const { catalog, record, hostModelReplacement } = state
  const shown =
    catalog && state.catalogSource === 'host'
      ? verifiedListReplacementRecord(catalog, record, hostModelReplacement)
      : record
  return shown === record ? state : { ...state, record: shown }
}

/**
 * What the picker shows before the host has confirmed this session's values:
 * `seed` (the selection a launch seeds) stands in until the record names a
 * model, and `held` picks outrank both until the host settles them. Both show
 * as `dispatched`, and a selection the host's current list lacks as its
 * `default` replacement; derived on every read, never written into the record.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const unconfirmedSeed = seed !== undefined && state.record.model === undefined
  const hasHeld = Object.keys(held).length > 0
  const replaced = unconfirmedSeed && hostReplacesSeedModel(state, seed)
  // A saved pick the host's list does not name would show its raw id or another model's label.
  if (
    unconfirmedSeed &&
    state.catalogSource === 'host' &&
    !hasHeld &&
    !replaced &&
    !catalogListsSeedModel(state, seed)
  ) {
    return { ...state, catalogSource: 'seed' }
  }
  // Only a host's or the session's list names a saved pick: a built-in label may be replaced.
  const seeded =
    unconfirmedSeed &&
    (state.catalogSource === 'host' || state.catalogSource === 'live') &&
    (replaced || catalogListsSeedModel(state, seed))
  if (!state.catalog || (!seeded && !hasHeld)) {
    return withVerifiedModelReplacement(state)
  }
  let view: StructuredAgentSessionOptionState = {
    ...state,
    record: cloneNativeChatSessionOptionRecord(state.record)
  }
  if (seeded) {
    view = commitStructuredAgentSessionOptionValues(view, seed)
  }
  return withVerifiedModelReplacement({
    ...commitStructuredAgentSessionOptionValues(view, held),
    pendingId: state.pendingId
  })
}

/** The session's options answer still holds a selection this host answer would replace: it was
 *  decided before the listing landed (a catalog answer is never applied over a session's own), so
 *  it is worth reading once more. */
export function sessionOptionsPredateHostModelReplacement(
  state: StructuredAgentSessionOptionState,
  catalog: AgentSessionModelCatalogResult
): boolean {
  const selected = state.record.model?.value
  return (
    state.catalogSource === 'live' &&
    catalog.origin !== 'unknown' &&
    unlistedAgentModelReplacement(
      catalog.models,
      typeof selected === 'string' ? selected : null,
      catalog.unlistedModelReplacement
    ) !== null
  )
}
