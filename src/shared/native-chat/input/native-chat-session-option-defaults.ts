import type { AgentType } from '../../agent-status-types'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionChoice,
  newChatPermissionModeForSettings,
  type NewChatPermissionSettings
} from '../../agent-chat-permission-mode'
import type { GlobalSettings } from '../../global-settings-types'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog,
  sessionOptionValueIsValid
} from '../../agent-session-option-catalog'
import type {
  NativeChatSessionOptionSettingsMutation,
  PersistedNativeChatSessionOptions,
  SessionOptionValue
} from './native-chat-session-options'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from '../../structured-agent-session-option-codec'

export function resolveNativeChatSessionOptionDefaults(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, SessionOptionValue> | undefined {
  const entry = persisted?.[agent]
  // Preserve CLI-configured defaults until the user explicitly selects a model that authorizes launch flags.
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

/** Canonical values seed through the existing durable string record; the codec
 *  is the only boundary that represents the boolean Fast preference as text. */
export const STRUCTURED_LAUNCH_SEED_OPTION_IDS = [
  'model',
  'effort',
  'fastMode',
  'serviceTier'
] as const

/** What a launch may hold and a create may seed; the permission mode never rewrites the selection. */
export const STRUCTURED_LAUNCH_OPTION_IDS = [
  ...STRUCTURED_LAUNCH_SEED_OPTION_IDS,
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID
] as const

/** Share bounded-string seed narrowing with orchestration --model/--effort. Empty results must be undefined:
 * an empty durable map throws agent_session_options_invalid outside wire refusals and strands launch fallback. */
export function narrowStructuredLaunchSeedOptions(
  values: Readonly<Record<string, unknown>> | null | undefined
): Record<string, string> | undefined {
  const seeded: Record<string, string> = {}
  for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS) {
    const value = values?.[id]
    if (id !== 'fastMode' && !(typeof value === 'string' && value.trim())) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (encoded !== null) {
        seeded[id] = encoded
      }
    }
  }
  return Object.keys(seeded).length > 0 ? seeded : undefined
}

/** An already-encoded seed read from another host or from storage: the seedable ids whose value
 *  decodes, or `undefined` when nothing usable remains. */
export function parseStructuredLaunchSeedOptions(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const entries = new Map<string, unknown>(Object.entries(value))
  const parsed: Record<string, string> = {}
  for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS) {
    const encoded = entries.get(id)
    if (
      typeof encoded === 'string' &&
      encoded.trim() &&
      decodeStructuredAgentSessionOptionValue(id, encoded) !== null
    ) {
      parsed[id] = encoded
    }
  }
  const permissionMode = entries.get(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
  if (isAgentChatPermissionChoice(permissionMode)) {
    parsed[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] = permissionMode
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/** The saved selection a structured create seeds into its string-valued reservation. */
export function resolveStructuredLaunchSeedOptions(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, string> | undefined {
  return narrowStructuredLaunchSeedOptions(resolveNativeChatSessionOptionDefaults(persisted, agent))
}

/** A new chat's seed: the saved selection plus the permission default narrowed to the agent. */
export function structuredLaunchSeedOptions(
  settings:
    | (Pick<GlobalSettings, 'nativeChatSessionOptions' | 'nativeChatPermissionMode'> &
        NewChatPermissionSettings)
    | null
    | undefined,
  agent: AgentType
): Record<string, string> | undefined {
  const selection = resolveStructuredLaunchSeedOptions(settings?.nativeChatSessionOptions, agent)
  const permissionMode = newChatPermissionModeForSettings(agent, settings)
  return permissionMode
    ? { ...selection, [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode }
    : selection
}

/** Apply settled picks in one pass for surfaces replacing the whole record, so later picks cannot drop earlier ones. */
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

/** Applies user picks; null means the saved selection stays unchanged. */
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
  // Older clients still send catalog-based clearing; observations cannot change a saved pick.
  return null
}

export function updateNativeChatSessionOptionDefaults(args: {
  persisted: PersistedNativeChatSessionOptions | null | undefined
  agent: AgentType
  modelId: string
  optionId: string
  value: SessionOptionValue
  /** Adopt by default or no launch can use the option. Picker withholds unconfirmed CLI-default guesses:
   * adopting one would emit -m on later launches and can fail on accounts lacking that model. */
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

/** A different model drops the prior model’s options, keeping the chat’s permission choice. Without
 *  a requested `model` the result only overlays the shown selection. */
export function structuredLaunchRequestedOptions(selection: {
  explicit?: Readonly<Record<string, string>>
  held: Readonly<Record<string, string>>
  seed?: Readonly<Record<string, string>>
}): Readonly<Record<string, string>> | undefined {
  const { explicit, held, seed } = selection
  if (!explicit) {
    return undefined
  }
  const changed = held.model !== undefined && held.model !== explicit.model
  const permissionMode =
    explicit[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ?? seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  return {
    ...(permissionMode ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode } : {}),
    ...(changed ? {} : explicit),
    ...held
  }
}

/** A create without model replacement overlays the remembered effort onto a named Claude/Codex
 *  model; the catalog default approximates omission there. */
export function structuredLaunchCompatibleOptions(
  agent: AgentType,
  requested: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  if (
    (agent !== 'claude' && agent !== 'codex') ||
    !requested.model ||
    requested.effort !== undefined
  ) {
    return requested
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  const options =
    catalog && (findCatalogModel(catalog, requested.model)?.options ?? catalog.unknownModelOptions)
  const effort = options?.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select' && effort.kind.defaultValue
    ? { ...requested, effort: effort.kind.defaultValue }
    : requested
}

export function seededPermissionMode(
  options: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const mode = options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  return mode ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: mode } : {}
}
