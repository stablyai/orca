import { isRecord } from '../../agent-status/child-work/agent-status-child-work-value-guards'

/** Supported input modalities reported for listed models. */
export const NATIVE_CHAT_MODEL_INPUT_KINDS = ['text', 'image', 'audio', 'video', 'pdf'] as const
/** An input modality a listed chat model accepts. */
export type NativeChatModelInputKind = (typeof NATIVE_CHAT_MODEL_INPUT_KINDS)[number]

/** Facts a host's model listing states; an absent field is unknown and shows nothing. */
export type NativeChatModelDetails = {
  provider?: string
  inputs?: NativeChatModelInputKind[]
  reasoning?: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
  free?: boolean
}

/** Keeps only well-formed fields; undefined when none survive. */
export function parseNativeChatModelDetails(value: unknown): NativeChatModelDetails | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const listed: unknown[] = Array.isArray(value.inputs) ? value.inputs : []
  const inputs = NATIVE_CHAT_MODEL_INPUT_KINDS.filter((kind) => listed.includes(kind))
  const contextWindowTokens = value.contextWindowTokens
  const maxOutputTokens = value.maxOutputTokens
  const details: NativeChatModelDetails = {
    ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(typeof value.reasoning === 'boolean' ? { reasoning: value.reasoning } : {}),
    ...(typeof contextWindowTokens === 'number' &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? { contextWindowTokens }
      : {}),
    ...(typeof maxOutputTokens === 'number' &&
    Number.isFinite(maxOutputTokens) &&
    maxOutputTokens > 0
      ? { maxOutputTokens }
      : {}),
    ...(typeof value.free === 'boolean' ? { free: value.free } : {})
  }
  return Object.keys(details).length > 0 ? details : undefined
}

type ModelWithDetails = { id: string; details?: NativeChatModelDetails }

/** Session answers omit listing facts; a later listing replaces only the fields it states. */
export function withListedModelDetails<T extends ModelWithDetails>(
  models: T[],
  listed: readonly ModelWithDetails[]
): T[] {
  const byId = new Map(listed.map((row) => [row.id, row.details]))
  return models.map((row) => {
    const listedDetails = byId.get(row.id)
    if (!listedDetails) {
      return row
    }
    const stated: NativeChatModelDetails = {
      ...(listedDetails.provider !== undefined ? { provider: listedDetails.provider } : {}),
      ...(listedDetails.inputs !== undefined ? { inputs: listedDetails.inputs } : {}),
      ...(listedDetails.reasoning !== undefined ? { reasoning: listedDetails.reasoning } : {}),
      ...(listedDetails.contextWindowTokens !== undefined
        ? { contextWindowTokens: listedDetails.contextWindowTokens }
        : {}),
      ...(listedDetails.maxOutputTokens !== undefined
        ? { maxOutputTokens: listedDetails.maxOutputTokens }
        : {}),
      ...(listedDetails.free !== undefined ? { free: listedDetails.free } : {})
    }
    if (Object.keys(stated).length === 0) {
      return row
    }
    // Session details are newer; catalog details fill only fields the session omits.
    return { ...row, details: { ...stated, ...row.details } }
  })
}

/** The listing's details, plus the catalog's stated context window when they lack one. */
export function catalogModelChoiceDetails(model: {
  details?: NativeChatModelDetails
  contextWindowTokens?: number
}): NativeChatModelDetails | undefined {
  if (!model.contextWindowTokens || model.details?.contextWindowTokens) {
    return model.details
  }
  return { ...model.details, contextWindowTokens: model.contextWindowTokens }
}
