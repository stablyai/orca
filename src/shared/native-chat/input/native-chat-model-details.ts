import { isRecord } from '../../agent-status/child-work/agent-status-child-work-value-guards'

export const NATIVE_CHAT_MODEL_INPUT_KINDS = ['text', 'image', 'audio', 'video'] as const
export type NativeChatModelInputKind = (typeof NATIVE_CHAT_MODEL_INPUT_KINDS)[number]

/** Facts a host's model listing states; an absent field is unknown and shows nothing. */
export type NativeChatModelDetails = {
  provider?: string
  inputs?: NativeChatModelInputKind[]
  reasoning?: boolean
  contextWindowTokens?: number
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
  const details: NativeChatModelDetails = {
    ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(typeof value.reasoning === 'boolean' ? { reasoning: value.reasoning } : {}),
    ...(typeof contextWindowTokens === 'number' &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? { contextWindowTokens }
      : {}),
    ...(typeof value.free === 'boolean' ? { free: value.free } : {})
  }
  return Object.keys(details).length > 0 ? details : undefined
}

type ModelWithDetails = { id: string; details?: NativeChatModelDetails }

/** Session answers omit listing facts; keep what the listing stated for the same model. */
export function withListedModelDetails<T extends ModelWithDetails>(
  models: T[],
  listed: readonly ModelWithDetails[]
): T[] {
  const byId = new Map(listed.map((row) => [row.id, row.details]))
  return models.map((row) => {
    const details = row.details ? undefined : byId.get(row.id)
    return details ? { ...row, details } : row
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
