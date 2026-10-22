import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import {
  cloneStructuredAgentSessionOptionRecord,
  structuredAgentSessionModelId,
  structuredAgentSessionOwnValue
} from './structured-agent-session-option-state'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'

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
 * model of the chat's own, and `held` picks outrank both until the host settles them. All show as `dispatched`;
 * derived on every read, never written into the record. A model the list lacks is kept: a list
 * is no evidence the chat's own model cannot run.
 *
 * The permission mode reads its own way: the held pick, else what the host stated, else the seed.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: heldPermission, ...heldSelection } = held
  const view = modelOptionView(state, seed, heldSelection)
  const permissionMode =
    heldPermission ?? state.permissionMode ?? seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ?? null
  return view.permissionMode === permissionMode ? view : { ...view, permissionMode }
}

/** The picker of a client that holds no launch selection, such as the phone. */
export function structuredAgentSessionShownSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  return structuredAgentSessionOptionSnapshot(
    structuredAgentSessionOptionView(state, undefined, {})
  )
}

function modelOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const unconfirmedSeed =
    seed !== undefined && structuredAgentSessionModelId(state.record, 'own') === null
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
    record: cloneStructuredAgentSessionOptionRecord(state.record)
  }
  if (seeded) {
    view = commitStructuredAgentSessionOptionValues(view, seed)
  }
  return { ...commitStructuredAgentSessionOptionValues(view, held), pendingId: state.pendingId }
}

/** The Claude model and effort a send carries: the chat's own and the picks over them in `view`.
 *  A new chat (or an older host's answer) sends the defaults it shows, so a new chat's first send
 *  pins them; a resumed chat shows its host's defaults but never sends them. */
export function structuredAgentSessionSendSelection(
  view: StructuredAgentSessionOptionState
): Record<string, string> | undefined {
  if (view.record.agent !== 'claude') {
    return undefined
  }
  const snapshot =
    view.catalog?.defaultModelIsCliDefault === true && !view.defaultsUnsent
      ? structuredAgentSessionOptionSnapshot(view)
      : []
  const shown = (id: string): string | undefined => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  const model = structuredAgentSessionOwnValue(view.record, 'model') ?? shown('model')
  const effort = structuredAgentSessionOwnValue(view.record, 'effort') ?? shown('effort')
  return model || effort
    ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    : undefined
}
