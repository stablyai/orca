import { sha256 } from '../../hashing/sha256'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

export function pipelineV2Fingerprint(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(value)))), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
