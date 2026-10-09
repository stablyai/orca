import {
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { cloneNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'

function catalogListsSeedModel(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>>
): boolean {
  const model = seed.model
  return model === undefined || Boolean(state.catalog?.models.some((entry) => entry.id === model))
}

/** The chat's mode is not per-model: the seed stands in for it until the host reports one. */
function withSeededPermission(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined
): StructuredAgentSessionOptionState {
  const seeded = state.permission === null ? seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] : undefined
  if (seeded === undefined) {
    return state
  }
  return {
    ...commitStructuredAgentSessionOption(state, AGENT_CHAT_PERMISSION_MODE_OPTION_ID, seeded),
    pendingId: state.pendingId
  }
}

/**
 * What the picker shows before the host has confirmed this session's values:
 * `seed` (the selection a launch seeds) stands in until the record names a
 * model (or, for the permission mode, until the host reports one), and `held`
 * picks outrank both until the host settles them. Both show as `dispatched`;
 * derived on every read, never written into the record.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const base = withSeededPermission(state, seed)
  const perModelSeed =
    seed === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(seed).filter(([id]) => id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
        )
  const unconfirmedSeed = perModelSeed !== undefined && base.record.model === undefined
  const hasHeld = Object.keys(held).length > 0
  // A saved pick the host's list does not name would show its raw id or another model's label.
  if (
    unconfirmedSeed &&
    base.catalogSource === 'host' &&
    !hasHeld &&
    !catalogListsSeedModel(base, perModelSeed)
  ) {
    return { ...base, catalogSource: 'seed' }
  }
  // Only a host's or the session's list names a saved pick: a built-in label may be replaced.
  const seeded =
    unconfirmedSeed &&
    (base.catalogSource === 'host' || base.catalogSource === 'live') &&
    catalogListsSeedModel(base, perModelSeed)
  // No catalog guard: a held permission pick applies before any model list exists.
  if (!seeded && !hasHeld) {
    return base
  }
  let view: StructuredAgentSessionOptionState = {
    ...base,
    record: cloneNativeChatSessionOptionRecord(base.record)
  }
  if (seeded) {
    view = commitStructuredAgentSessionOptionValues(view, perModelSeed)
  }
  return { ...commitStructuredAgentSessionOptionValues(view, held), pendingId: state.pendingId }
}
