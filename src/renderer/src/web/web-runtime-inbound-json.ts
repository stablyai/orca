import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError,
  type JsonTextStructureLimits
} from '../../../shared/json-text-structure-limit'

export const WEB_RUNTIME_INBOUND_JSON_STRUCTURE_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 1_000_000,
  nestingDepth: 128
}

export function parseWebRuntimeInboundJson<T = unknown>(
  content: string,
  limits: JsonTextStructureLimits = WEB_RUNTIME_INBOUND_JSON_STRUCTURE_LIMITS
): T {
  assertJsonTextStructureWithinLimits(content, limits)
  return JSON.parse(content) as T
}

export function isWebRuntimeJsonStructureCapacityError(
  error: unknown
): error is JsonTextStructureCapacityError {
  return error instanceof JsonTextStructureCapacityError
}
