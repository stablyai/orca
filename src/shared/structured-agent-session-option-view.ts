import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import { cloneNativeChatSessionOptionRecord } from './native-chat-session-option-state'
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
 * model, and `held` picks outrank both until the host settles them, as does what a send moves
 * a model the verified list lacks to. All show as `dispatched`; derived on every read, never
 * written into the record.
 *
 * The permission mode reads its own way: the held pick, else what the host stated, else the seed.
 * A host that cannot take a send's model keeps running the chat's own, so that is what shows.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  takesSendOptions: boolean
): StructuredAgentSessionOptionState {
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: heldPermission, ...heldSelection } = held
  const replaced = takesSendOptions
    ? structuredAgentSessionListedPicks(state, seed, heldSelection)
    : null
  const view = modelOptionView(state, seed, { ...heldSelection, ...replaced })
  const permissionMode =
    heldPermission ?? state.permissionMode ?? seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ?? null
  return view.permissionMode === permissionMode ? view : { ...view, permissionMode }
}

/** The picker of a client that holds no launch selection, such as the phone. */
export function structuredAgentSessionShownSnapshot(
  state: StructuredAgentSessionOptionState,
  takesSendOptions: boolean
): SessionOptionDescriptor[] {
  return structuredAgentSessionOptionSnapshot(
    structuredAgentSessionOptionView(state, undefined, {}, takesSendOptions)
  )
}

function modelOptionView(
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

const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** `previous` if `supported` offers it, else the nearest offered level (the higher on a tie). */
export function nearestAgentEffort(
  previous: string,
  supported: readonly string[]
): string | undefined {
  const rank = (level: string): number => EFFORT_RANK.indexOf(level)
  const distance = (level: string): number => Math.abs(rank(level) - rank(previous))
  if (supported.includes(previous)) {
    return previous
  }
  if (rank(previous) === -1) {
    return undefined
  }
  return supported
    .filter((level) => rank(level) !== -1)
    .sort((a, b) => distance(a) - distance(b) || rank(b) - rank(a))[0]
}

/** What a send moves a Claude chat to when the finished listing the picker shows does not name its
 *  model (held, else recorded, else seeded): that listing's default row, else its first, with the
 *  effort moved to the nearest level offered. Null keeps the model. */
export function structuredAgentSessionListedPicks(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): Record<string, string> | null {
  const { catalog, catalogSource, record, verifiedModelIds: own } = state
  const tracked = record.model?.value
  const model = held.model ?? (typeof tracked === 'string' ? tracked : seed?.model)
  // Only the listing proves a row: the session's own unlisted model is shown but never listed. An
  // older host's answer proves none, so only its own default may stand in, where the host lists it.
  const coherent = state.choiceCatalog
  if (coherent && (!coherent.complete || performance.now() >= coherent.verifiedUntil)) {
    return null
  }
  const verified = coherent
    ? coherent.models.map((row) => row.id)
    : (own ?? state.hostListedModelIds ?? [])
  const rows =
    catalog?.models.filter(
      (row) =>
        verified.includes(row.id) && (coherent !== undefined || own !== undefined || row.isDefault)
    ) ?? []
  if (
    record.agent !== 'claude' ||
    (catalogSource !== 'host' && catalogSource !== 'live') ||
    !model ||
    rows.length === 0 ||
    verified.includes(model)
  ) {
    return null
  }
  const recorded = record.valuesByModel[model]?.effort?.value
  const effort =
    held.effort ??
    (typeof recorded === 'string' ? recorded : seed?.model === model ? seed.effort : undefined)
  const defaultId = coherent?.models.find((row) => row.isDefault)?.id
  const target = coherent
    ? (rows.find((row) => row.id === defaultId) ?? rows[0]!)
    : (rows.find((row) => row.isDefault) ?? rows[0]!)
  const levels = target.options.find((option) => option.id === 'effort')?.kind
  const carried =
    effort && levels?.type === 'select'
      ? nearestAgentEffort(
          effort,
          levels.choices.map((choice) => choice.value)
        )
      : undefined
  return { model: target.id, ...(carried ? { effort: carried } : {}) }
}

/** The Claude model and effort the composer shows (`snapshot`), which every send carries. */
export function structuredAgentSessionSendSelection(
  agent: string,
  snapshot: readonly SessionOptionDescriptor[],
  omitProvisional = false
): Record<string, string> | undefined {
  if (agent !== 'claude') {
    return undefined
  }
  const shown = (id: string): string | undefined => {
    const descriptor = snapshot.find((entry) => entry.id === id)
    if (omitProvisional && descriptor?.valueSource === 'default') {
      return undefined
    }
    const kind = descriptor?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  const model = shown('model')
  const effort = shown('effort')
  return model ? { model, ...(effort ? { effort } : {}) } : undefined
}
