import type { AgentType } from './agent-status-types'
import { sessionOptionValueIsValid } from './agent-session-option-catalog'
import type {
  NativeChatSessionOptionSettingsMutation,
  PersistedNativeChatSessionOptions,
  SessionOptionValue
} from './native-chat-session-options'

export function resolveNativeChatSessionOptionDefaults(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, SessionOptionValue> | undefined {
  const entry = persisted?.[agent]
  // Why: untouched settings must preserve the agent CLI's configured defaults;
  // only a model explicitly selected by the user authorizes launch flags.
  const modelId = typeof entry?.model === 'string' && entry.model.trim() ? entry.model : undefined
  if (!modelId) {
    return undefined
  }
  const values: Record<string, SessionOptionValue> = { model: modelId }
  const storedValues = entry?.valuesByModel?.[modelId]
  if (storedValues && typeof storedValues === 'object') {
    for (const [id, value] of Object.entries(storedValues)) {
      if (sessionOptionValueIsValid(value)) {
        values[id] = value
      }
    }
  }
  return values
}

/** Why only these two: they are the only ids the picker persists into
 *  `nativeChatSessionOptions` that both structured providers also accept as
 *  strings. Claude's `fastMode` is a boolean the durable `Record<string, string>`
 *  record cannot carry, and the providers' remaining keys are settable only
 *  mid-session, never seeded at launch. */
export const STRUCTURED_LAUNCH_SEED_OPTION_IDS = ['model', 'effort'] as const

/** Any chosen option set narrowed to what a structured create may seed: the seedable ids only,
 *  each a non-empty string. An empty result is `undefined` rather than `{}` — an empty map fails
 *  the durable record's bounded-string guard, and `agent_session_options_invalid` is not a wire
 *  refusal code, so the throw strands the launch with no fallback.
 *
 *  Shared with orchestration, whose `--model`/`--effort` seed a worker's session the same way a
 *  saved selection seeds the user's own chat. */
export function narrowStructuredLaunchSeedOptions(
  values: Readonly<Record<string, unknown>> | null | undefined
): Record<string, string> | undefined {
  const seeded: Record<string, string> = {}
  for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS) {
    const value = values?.[id]
    if (typeof value === 'string' && value.trim()) {
      seeded[id] = value
    }
  }
  return Object.keys(seeded).length > 0 ? seeded : undefined
}

/** The saved selection a structured create seeds into its reservation, narrowed
 *  to the wire-safe string subset the durable record and both providers accept. */
export function resolveStructuredLaunchSeedOptions(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, string> | undefined {
  return narrowStructuredLaunchSeedOptions(resolveNativeChatSessionOptionDefaults(persisted, agent))
}

/** Fold a settled batch of picks onto the durable record. A surface that must send the
 *  whole object back — rather than merging key by key — applies them in one pass so a
 *  later pick in the batch cannot drop an earlier one. */
export function applyNativeChatSessionOptionPicks(args: {
  persisted: PersistedNativeChatSessionOptions | null | undefined
  agent: AgentType
  picks: Extract<NativeChatSessionOptionSettingsMutation, { type: 'apply-picks' }>['picks']
}): PersistedNativeChatSessionOptions {
  let persisted = args.persisted ?? {}
  for (const pick of args.picks) {
    persisted = updateNativeChatSessionOptionDefaults({ persisted, agent: args.agent, ...pick })
  }
  return persisted
}

/** Applies one host-owned delta to the latest record. Returning null means the
 * authoritative model list found nothing to retire. */
export function applyNativeChatSessionOptionSettingsMutation(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  mutation: NativeChatSessionOptionSettingsMutation
): PersistedNativeChatSessionOptions | null {
  if (mutation.type === 'apply-picks') {
    return applyNativeChatSessionOptionPicks({
      persisted,
      agent: mutation.agent,
      picks: mutation.picks
    })
  }
  const modelId = persisted?.[mutation.agent]?.model
  if (!modelId || mutation.availableModelIds.includes(modelId)) {
    return null
  }
  return clearNativeChatSessionOptionModel(persisted, mutation.agent)
}

/** Why: an authoritative probe proved this id gone, and a stale `model` is emitted
 *  verbatim as a launch flag — grok exits fatally on an unknown one. Dropping only
 *  `model` keeps the per-model option values for a later reselect. */
export function clearNativeChatSessionOptionModel(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): PersistedNativeChatSessionOptions {
  const currentAgent = persisted?.[agent]
  if (!currentAgent?.model) {
    return { ...persisted }
  }
  const { model: _dropped, ...rest } = currentAgent
  return { ...persisted, [agent]: rest }
}

export function updateNativeChatSessionOptionDefaults(args: {
  persisted: PersistedNativeChatSessionOptions | null | undefined
  agent: AgentType
  modelId: string
  optionId: string
  value: SessionOptionValue
  /** Defaults to adopting, since without a `model` no launch resolves the value at all.
   *  Only the picker surface, which can tell a probe-confirmed id from the seed's guess
   *  at the CLI default, withholds it: adopting a guess would emit `-m <guess>` on every
   *  later launch, fatal on an account without that model. */
  adoptModelAsLaunchDefault?: boolean
}): PersistedNativeChatSessionOptions {
  const currentAgent = args.persisted?.[args.agent]
  const currentModelValues = currentAgent?.valuesByModel?.[args.modelId] ?? {}
  const valuesByModel = {
    ...currentAgent?.valuesByModel,
    ...(args.optionId === 'model'
      ? {}
      : {
          [args.modelId]: { ...currentModelValues, [args.optionId]: args.value }
        })
  }
  return {
    ...args.persisted,
    [args.agent]: {
      ...currentAgent,
      ...(args.adoptModelAsLaunchDefault === false
        ? {}
        : { model: args.optionId === 'model' ? String(args.value) : args.modelId }),
      valuesByModel
    }
  }
}
