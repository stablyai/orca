import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

export const RELAY_JSON_MAX_STRUCTURAL_TOKENS = 1_000_000
export const RELAY_JSON_MAX_NESTING_DEPTH = 128

export function parseRelayJsonText<T>(text: string): T {
  assertJsonTextStructureWithinLimits(text, {
    structuralTokens: RELAY_JSON_MAX_STRUCTURAL_TOKENS,
    nestingDepth: RELAY_JSON_MAX_NESTING_DEPTH
  })
  return JSON.parse(text) as T
}
