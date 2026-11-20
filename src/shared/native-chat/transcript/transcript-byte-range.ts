export type TranscriptByteRange = { start: number; end: number; digest: string }

export function transcriptDigestHex(value: bigint): string {
  return BigInt.asUintN(64, value).toString(16).padStart(16, '0')
}

export function mergeTranscriptRanges(
  ranges: readonly TranscriptByteRange[]
): TranscriptByteRange[] {
  const merged: TranscriptByteRange[] = []
  for (const range of ranges.toSorted((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1)
    if (last && range.end <= last.end) {
      continue
    }
    if (last?.end === range.start) {
      merged[merged.length - 1] = {
        start: last.start,
        end: range.end,
        digest: transcriptDigestHex(BigInt(`0x${last.digest}`) + BigInt(`0x${range.digest}`))
      }
    } else {
      merged.push(range)
    }
  }
  return merged
}

/** Bytes that changed while they were hashed prove nothing either way, so the caller verifies again later. */
export const TRANSCRIPT_RANGES_UNSETTLED = 'unsettled'

export type TranscriptRangeVerification = boolean[] | typeof TRANSCRIPT_RANGES_UNSETTLED

export function parseTranscriptRangeVerification(value: unknown): TranscriptRangeVerification {
  if (value === TRANSCRIPT_RANGES_UNSETTLED) {
    return value
  }
  if (Array.isArray(value) && value.every((item): item is boolean => typeof item === 'boolean')) {
    return value
  }
  throw new Error('Invalid transcript range verification result')
}
