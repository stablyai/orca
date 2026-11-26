import type { AntigravityTokenPrices } from './antigravity-transcript-usage'

// Standard text API rates, verified 2026-11-16: https://aistudio.google.com/docs/pricing
export function antigravityPublishedPrices(
  model: string | null,
  createdAt: string | null
): AntigravityTokenPrices | undefined {
  const timestamp = createdAt ? Date.parse(createdAt) : Number.NaN
  if (!model || !Number.isFinite(timestamp)) {
    return undefined
  }
  if (/^gemini-4-hydrogen(?:-(?:low|medium|high|xhigh))?$/.test(model)) {
    return { inputUsdPerMillion: 1.5, cacheReadUsdPerMillion: 0.075, outputUsdPerMillion: 7.5 }
  }
  if (/^gemini-4-(?:carbon|argon)(?:-(?:low|medium|high))?$/.test(model)) {
    return timestamp < Date.parse('2026-12-01T00:00:00Z')
      ? { inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.1, outputUsdPerMillion: 10 }
      : { inputUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 20 }
  }
  if (/^gemini-3\.8-flash(?:-(?:low|medium|high))?$/.test(model)) {
    return timestamp < Date.parse('2027-01-01T00:00:00Z')
      ? { inputUsdPerMillion: 0.75, cacheReadUsdPerMillion: 0.075, outputUsdPerMillion: 3.75 }
      : { inputUsdPerMillion: 1.5, cacheReadUsdPerMillion: 0.15, outputUsdPerMillion: 7.5 }
  }
  return undefined
}
