export const NDJSON_MAX_LINE_BYTES = 16 * 1024 * 1024

export class NdjsonLineTooLongError extends Error {
  constructor(
    readonly lineBytes: number,
    readonly maxLineBytes: number
  ) {
    super(`NDJSON line exceeds max ${maxLineBytes} bytes (${lineBytes} bytes encoded)`)
    this.name = 'NdjsonLineTooLongError'
  }
}

export type NdjsonRejectedRecord =
  | {
      kind: 'line-too-long'
      maxLineBytes: number
      observedBytes: number
      prefix: string
      droppedCompleteRecords?: true
    }
  | { kind: 'invalid-json'; line: string; error: Error }

export function encodeNdjson(msg: unknown, maxLineBytes = NDJSON_MAX_LINE_BYTES): string {
  const line = JSON.stringify(msg)
  const lineBytes = Buffer.byteLength(line, 'utf8')
  if (lineBytes > maxLineBytes) {
    throw new NdjsonLineTooLongError(lineBytes, maxLineBytes)
  }
  return `${line}\n`
}

export function boundedUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value
  }
  let low = 0
  let high = Math.min(value.length, maxBytes)
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, midpoint), 'utf8') <= maxBytes) {
      low = midpoint
    } else {
      high = midpoint - 1
    }
  }
  return value.slice(0, low)
}
