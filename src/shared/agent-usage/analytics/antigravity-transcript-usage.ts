export type AntigravityTranscriptUsage = Readonly<{
  step: number
  model: string | null
  createdAt: string | null
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  totalTokens: number
}>

export type AntigravityTokenPrices = {
  inputUsdPerMillion: number
  cacheReadUsdPerMillion: number
  outputUsdPerMillion: number
}

export function readAntigravityTranscriptUsage(
  record: Record<string, unknown>
): AntigravityTranscriptUsage | null {
  if (
    record.source !== 'MODEL' ||
    record.type !== 'PLANNER_RESPONSE' ||
    record.status !== 'DONE' ||
    !isTokenCount(record.step_index) ||
    !isTokenCount(record.input_tokens) ||
    !isTokenCount(record.cache_read_tokens) ||
    !isTokenCount(record.output_tokens)
  ) {
    return null
  }
  // Cache reads are separate from fresh input; thinking is already included in output.
  const totalTokens = record.input_tokens + record.cache_read_tokens + record.output_tokens
  if (!Number.isSafeInteger(totalTokens)) {
    return null
  }
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  return {
    step: record.step_index,
    model: model && model.length <= 256 ? model : null,
    createdAt:
      typeof record.created_at === 'string' && Number.isFinite(Date.parse(record.created_at))
        ? record.created_at
        : null,
    inputTokens: record.input_tokens,
    cacheReadTokens: record.cache_read_tokens,
    outputTokens: record.output_tokens,
    totalTokens
  }
}

export function estimateAntigravityUsageUsd(
  usage: AntigravityTranscriptUsage,
  prices: AntigravityTokenPrices | undefined
): number | null {
  if (
    !usage.model ||
    !prices ||
    !validPrice(prices.inputUsdPerMillion) ||
    !validPrice(prices.cacheReadUsdPerMillion) ||
    !validPrice(prices.outputUsdPerMillion)
  ) {
    return null
  }
  const cost =
    (usage.inputTokens * prices.inputUsdPerMillion +
      usage.cacheReadTokens * prices.cacheReadUsdPerMillion +
      usage.outputTokens * prices.outputUsdPerMillion) /
    1_000_000
  return Number.isFinite(cost) ? cost : null
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
