export type TranscriptByteRange = { start: number; end: number; digest: string }

export function transcriptDigestHex(value: bigint): string {
  return BigInt.asUintN(64, value).toString(16).padStart(16, '0')
}
