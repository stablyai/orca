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
import { structuredAgentSessionDescribedModel } from './structured-agent-session-option-snapshot'

/** Query base or immutable launch seed, with finite controller operations above it.
 *  Display provenance stays separate from accepted input while catalog labels load. */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  explicit?: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  if (state.optionsAnswerPresent) {
    seed = undefined
    explicit = undefined
  }
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
  const view = structuredAgentSessionOptionView(state, undefined, {})
  const snapshot = structuredAgentSessionOptionSnapshot(view)
  const model = structuredAgentSessionModelId(view.record, 'any')
  if (
    view.record.agent !== 'codex' ||
    !model ||
    !snapshot.some(
      (descriptor) =>
        descriptor.id === 'effort' &&
        descriptor.kind.type === 'select' &&
        descriptor.kind.currentValue === undefined
    ) ||
    !view.verifiedModelIds?.includes(model)
  ) {
    return snapshot
  }
  const effort = structuredAgentSessionDescribedModel(view, model)?.options.find(
    (option) => option.id === 'effort'
  )?.kind
  if (effort?.type !== 'select' || !effort.defaultIsCliDefault) {
    return snapshot
  }
  // A listed default supplies context only; both Send paths still read the canonical snapshot.
  return snapshot.map((descriptor) =>
    descriptor.id === 'effort' &&
    descriptor.kind.type === 'select' &&
    descriptor.kind.currentValue === undefined
      ? {
          ...descriptor,
          valueSource: 'default',
          kind: { ...descriptor.kind, currentValue: effort.defaultValue }
        }
      : descriptor
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
  if (!state.catalog || (!unconfirmedSeed && !hasHeld)) {
    return state
  }
  let view: StructuredAgentSessionOptionState = {
    ...state,
    record: cloneStructuredAgentSessionOptionRecord(state.record)
  }
  if (unconfirmedSeed) {
    view = commitStructuredAgentSessionOptionValues(view, seed, 'seeded')
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

/** Exact capture uses accepted origins; absent metadata keeps the older host contract. */
export function structuredAgentSessionMessageSelection(
  view: StructuredAgentSessionOptionState
): Record<string, string> {
  const selection: Record<string, string> = {}
  const snapshot = structuredAgentSessionOptionSnapshot(view)
  for (const id of ['model', 'effort', 'fastMode', 'serviceTier'] as const) {
    const descriptor = snapshot.find((entry) => entry.id === id)
    if (view.acceptedInputSources !== undefined) {
      if (!view.acceptedInputSources[id]) {
        continue
      }
    } else if (
      (id === 'model' || id === 'effort') &&
      view.defaultsUnsent &&
      descriptor?.valueSource === 'default'
    ) {
      continue
    }
    const raw =
      view.record.agent === 'pi' && (id === 'model' || id === 'effort')
        ? view.record.values[id]?.value
        : undefined
    const value =
      raw ??
      descriptor?.kind.currentValue ??
      (view.acceptedInputSources !== undefined ? view.record.values[id]?.value : undefined)
    if (value !== undefined) {
      selection[id] = String(value)
    }
  }
  return selection
}
