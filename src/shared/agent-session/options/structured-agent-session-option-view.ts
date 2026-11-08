import { structuredLaunchRequestedOptions } from '../../native-chat/input/native-chat-session-option-defaults'
import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  structuredAgentSessionOptionSnapshot,
  structuredAgentSessionDescribedModel
} from './structured-agent-session-option-snapshot'
import type { SessionOptionDescriptor } from '../../native-chat/input/native-chat-session-options'
import {
  cloneStructuredAgentSessionOptionRecord,
  createStructuredAgentSessionOptionRecord,
  structuredAgentSessionModelId,
  structuredAgentSessionOwnValue
} from './structured-agent-session-option-state'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../agent-launch/permissions/agent-chat-permission-mode'

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
  const {
    [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: heldPermission,
    interactionMode,
    ...heldSelection
  } = held
  const modelView = modelOptionView(state, seed, heldSelection)
  const requestedMode = interactionMode ?? requested?.interactionMode
  const view =
    requestedMode === undefined
      ? modelView
      : commitStructuredAgentSessionOptionValues(
          { ...modelView, record: cloneStructuredAgentSessionOptionRecord(modelView.record) },
          { interactionMode: requestedMode }
        )
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
  const modelOption = snapshot.find((descriptor) => descriptor.id === 'model')
  const model = modelOption?.kind.currentValue
  const descriptor = snapshot.find((entry) => entry.id === 'effort')
  if (
    view.record.values.effort !== undefined ||
    descriptor?.valueSource === 'reported' ||
    typeof model !== 'string' ||
    descriptor?.kind.type !== 'select'
  ) {
    return snapshot
  }
  const described = structuredAgentSessionDescribedModel(view, model)
  const effort = described?.options.find((option) => option.id === 'effort')?.kind
  const declaration = described?.declaredDefaultEffort
  const fallback =
    declaration !== undefined
      ? declaration
      : view.record.agent === 'codex' &&
          view.verifiedModelIds?.includes(model) &&
          effort?.type === 'select' &&
          effort.defaultIsCliDefault
        ? effort.defaultValue
        : undefined
  const currentValue =
    fallback &&
    effort?.type === 'select' &&
    (declaration === undefined || effort.choices.some((choice) => choice.value === fallback))
      ? fallback
      : undefined
  if (descriptor.kind.currentValue === currentValue) {
    return snapshot
  }
  const kind = descriptor.kind
  // Observations supply display context; capture reads accepted literal input separately.
  return snapshot.map((entry) =>
    entry === descriptor
      ? {
          ...entry,
          valueSource: currentValue ? 'default' : 'unknown',
          kind: { ...kind, currentValue }
        }
      : entry
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
  return commitStructuredAgentSessionOptionValues(view, held)
}

/** Claude keeps the legacy baseline for older hosts; current hosts never send a shown default or a report. */
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
  const accepted = view.acceptedInputSources
  const tracked = view.record.values.model
  // A local pick the host has not saved yet still counts; a report does not.
  const model =
    accepted === undefined
      ? (structuredAgentSessionOwnValue(view.record, 'model') ?? shown('model'))
      : accepted.model || (tracked && tracked.source !== 'reported')
        ? structuredAgentSessionOwnValue(view.record, 'model')
        : undefined
  const effort =
    accepted !== undefined
      ? accepted.effort
        ? view.record.values.effort?.value
        : undefined
      : (structuredAgentSessionOwnValue(view.record, 'effort') ?? shown('effort'))
  return model || effort
    ? { ...(model ? { model: String(model) } : {}), ...(effort ? { effort: String(effort) } : {}) }
    : undefined
}

/** Exact capture uses accepted origins; absent metadata keeps the older host contract. */
export function structuredAgentSessionMessageSelection(
  view: StructuredAgentSessionOptionState
): Record<string, string> {
  const selection: Record<string, string> = {}
  const snapshot = structuredAgentSessionOptionSnapshot(view)
  for (const id of ['model', 'effort', 'fastMode', 'serviceTier', 'interactionMode'] as const) {
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
      (id === 'effort' && view.acceptedInputSources !== undefined) ||
      (view.record.agent === 'pi' && (id === 'model' || id === 'effort'))
        ? view.record.values[id]?.value
        : undefined
    const value =
      id === 'effort' && view.acceptedInputSources !== undefined
        ? raw
        : (raw ??
          descriptor?.kind.currentValue ??
          (view.acceptedInputSources !== undefined ? view.record.values[id]?.value : undefined))
    if (value !== undefined) {
      selection[id] = String(value)
    }
  }
  return selection
}
