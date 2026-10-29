import { structuredLaunchRequestedOptions } from './native-chat/input/native-chat-session-option-defaults'
import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type { SessionOptionDescriptor } from './native-chat/input/native-chat-session-options'
import {
  cloneStructuredAgentSessionOptionRecord,
  createStructuredAgentSessionOptionRecord,
  structuredAgentSessionModelId,
  structuredAgentSessionOwnValue
} from './structured-agent-session-option-state'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'

/** Derive held picks, host values and launch seeds without mutating the record; retain unlisted models.
 * Permission mode uses held, host, explicit launch mode, then seed. */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  explicit?: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const requested = structuredLaunchRequestedOptions({ explicit, seed, held })
  // Only a requested model replaces the shown selection; a permission mode alone overlays it.
  if (requested?.model !== undefined) {
    return commitStructuredAgentSessionOptionValues(
      { ...state, record: createStructuredAgentSessionOptionRecord(state.record.agent) },
      requested
    )
  }
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: heldPermission, ...heldSelection } = held
  const view = modelOptionView(state, seed, heldSelection)
  const permissionMode =
    heldPermission ??
    state.permissionMode ??
    requested?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ??
    seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ??
    null
  return view.permissionMode === permissionMode ? view : { ...view, permissionMode }
}

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
  const seeded =
    unconfirmedSeed &&
    (state.catalogSource === 'host' || state.catalogSource === 'live') &&
    (held.model === undefined || held.model === seed.model)
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

/** Claude sends its own values plus held picks. New chats/older hosts pin shown defaults on first send; resumed chats display defaults without sending them. */
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
