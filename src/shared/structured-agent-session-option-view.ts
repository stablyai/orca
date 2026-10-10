import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { cloneNativeChatSessionOptionRecord } from './native-chat-session-option-state'

function catalogListsSeedModel(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>>
): boolean {
  const model = seed.model
  return model === undefined || Boolean(state.catalog?.models.some((entry) => entry.id === model))
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
  const unconfirmedSeed = seed !== undefined && state.record.model === undefined
  const hasHeld = Object.keys(held).length > 0
  // A saved pick the host's list does not name would show its raw id or another model's label.
  if (
    unconfirmedSeed &&
    state.catalogSource === 'host' &&
    !hasHeld &&
    !catalogListsSeedModel(state, seed)
  ) {
    return { ...state, catalogSource: 'seed' }
  }
  // Only a host's or the session's list names a saved pick: a built-in label may be replaced.
  const seeded =
    unconfirmedSeed &&
    (state.catalogSource === 'host' || state.catalogSource === 'live') &&
    catalogListsSeedModel(state, seed)
  if (!state.catalog || (!seeded && !hasHeld)) {
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
