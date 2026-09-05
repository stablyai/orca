export const NDJSON_MAX_LINE_BYTES = 16 * 1024 * 1024

const REJECTED_LINE_PREFIX_MAX_BYTES = 64 * 1024
// Paused consumers may receive many individually valid records. Keep that queue
// bounded independently from the unterminated-record suffix cap.
const PAUSED_COMPLETE_RECORD_QUEUE_MAX_BYTES = 64 * 1024 * 1024

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
    }
  | { kind: 'invalid-json'; line: string; error: Error }

export type IncrementalNdjsonFramer = {
  feed(chunk: string): void
  resume(): void
  reset(): void
}

export type IncrementalNdjsonFramerOptions = {
  maxLineBytes?: number
  shouldPause?: () => boolean
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function boundedUtf8Prefix(value: string, maxBytes: number): string {
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

/** Incremental main-process NDJSON framing with bounded unterminated-line retention. */
export function createIncrementalNdjsonFramer(
  onRecord: (record: unknown, line: string) => void,
  onRejected: (rejected: NdjsonRejectedRecord) => void,
  options: IncrementalNdjsonFramerOptions = {}
): IncrementalNdjsonFramer {
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
  const maxPendingInputBytes = Math.max(REJECTED_LINE_PREFIX_MAX_BYTES, maxLineBytes * 2)
  let lineSegments: string[] = []
  let lineBytes = 0
  let prefixSegments: string[] = []
  let prefixBytes = 0
  let discardingOversizedLine = false
  let pendingInput: string | null = null
  let pausedCompleteInput: string[] = []
  let pausedCompleteInputBytes = 0
  let pausedCompleteInputOverflowed = false
  const maxQueuedCompleteInputBytes = Math.max(
    maxPendingInputBytes,
    PAUSED_COMPLETE_RECORD_QUEUE_MAX_BYTES
  )

  const clearLine = (): void => {
    lineSegments = []
    lineBytes = 0
    prefixSegments = []
    prefixBytes = 0
  }

  const rememberPrefix = (segment: string, segmentBytes: number): void => {
    const remainingBytes = REJECTED_LINE_PREFIX_MAX_BYTES - prefixBytes
    if (remainingBytes <= 0 || segment.length === 0) {
      return
    }
    const prefix =
      segmentBytes <= remainingBytes ? segment : boundedUtf8Prefix(segment, remainingBytes)
    prefixSegments.push(prefix)
    prefixBytes += prefix === segment ? segmentBytes : Buffer.byteLength(prefix, 'utf8')
  }

  const queuePausedCompleteInput = (complete: string): void => {
    if (complete.length === 0 || pausedCompleteInputOverflowed) {
      return
    }
    const completeBytes = Buffer.byteLength(complete, 'utf8')
    if (pausedCompleteInputBytes + completeBytes > maxQueuedCompleteInputBytes) {
      pausedCompleteInputOverflowed = true
      onRejected({
        kind: 'line-too-long',
        maxLineBytes: maxQueuedCompleteInputBytes,
        observedBytes: pausedCompleteInputBytes + completeBytes,
        prefix: boundedUtf8Prefix(complete, REJECTED_LINE_PREFIX_MAX_BYTES)
      })
      return
    }
    pausedCompleteInput.push(complete)
    pausedCompleteInputBytes += completeBytes
  }

  const retainPendingSuffix = (suffix: string): void => {
    if (suffix.length === 0) {
      pendingInput = null
      return
    }
    const suffixBytes = Buffer.byteLength(suffix, 'utf8')
    if (suffixBytes > maxPendingInputBytes) {
      onRejected({
        kind: 'line-too-long',
        maxLineBytes: maxPendingInputBytes,
        observedBytes: suffixBytes,
        prefix: boundedUtf8Prefix(suffix, REJECTED_LINE_PREFIX_MAX_BYTES)
      })
      pendingInput = null
      discardingOversizedLine = true
      return
    }
    pendingInput = suffix
  }

  const process = (input: string): void => {
    let cursor = 0
    while (cursor < input.length) {
      const newlineIndex = input.indexOf('\n', cursor)
      const hasNewline = newlineIndex !== -1
      const end = hasNewline ? newlineIndex : input.length
      const segment = input.slice(cursor, end)
      cursor = hasNewline ? end + 1 : end

      if (discardingOversizedLine) {
        if (hasNewline) {
          discardingOversizedLine = false
          clearLine()
        } else {
          return
        }
      } else {
        const segmentBytes = Buffer.byteLength(segment, 'utf8')
        const nextLineBytes = lineBytes + segmentBytes
        rememberPrefix(segment, segmentBytes)
        if (nextLineBytes > maxLineBytes) {
          const rejected: NdjsonRejectedRecord = {
            kind: 'line-too-long',
            maxLineBytes,
            observedBytes: nextLineBytes,
            prefix: prefixSegments.join('')
          }
          clearLine()
          discardingOversizedLine = !hasNewline
          onRejected(rejected)
        } else if (!hasNewline) {
          lineSegments.push(segment)
          lineBytes = nextLineBytes
          return
        } else {
          lineSegments.push(segment)
          const line = lineSegments.length === 1 ? lineSegments[0] : lineSegments.join('')
          clearLine()
          if (!/^\s*$/.test(line)) {
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch (error) {
              onRejected({ kind: 'invalid-json', line, error: errorFrom(error) })
              continue
            }
            onRecord(parsed, line)
          }
        }
      }

      if (options.shouldPause?.() && cursor < input.length) {
        const remainder = input.slice(cursor)
        const newlineIndex = remainder.lastIndexOf('\n')
        const complete = newlineIndex === -1 ? '' : remainder.slice(0, newlineIndex + 1)
        const suffix = newlineIndex === -1 ? remainder : remainder.slice(newlineIndex + 1)
        queuePausedCompleteInput(complete)
        retainPendingSuffix(suffix)
        return
      }
    }
  }

  return {
    feed(chunk): void {
      if (chunk.length === 0) {
        return
      }
      if (pausedCompleteInputBytes > 0 && !options.shouldPause?.()) {
        const queued = pausedCompleteInput
        pausedCompleteInput = []
        pausedCompleteInputBytes = 0
        process(queued.join(''))
      }
      if (pendingInput !== null || pausedCompleteInputBytes > 0) {
        // Complete records are retained as a separate bounded queue. The pending
        // input limit applies only to the final, actually incomplete record.
        if (pendingInput === null) {
          if (options.shouldPause?.()) {
            const newlineIndex = chunk.lastIndexOf('\n')
            const complete = newlineIndex === -1 ? '' : chunk.slice(0, newlineIndex + 1)
            const suffix = newlineIndex === -1 ? chunk : chunk.slice(newlineIndex + 1)
            queuePausedCompleteInput(complete)
            retainPendingSuffix(suffix)
            return
          }
          process(chunk)
          return
        }
        const combined = pendingInput + chunk
        const newlineIndex = combined.lastIndexOf('\n')
        const complete = newlineIndex === -1 ? '' : combined.slice(0, newlineIndex + 1)
        const suffix = newlineIndex === -1 ? combined : combined.slice(newlineIndex + 1)
        queuePausedCompleteInput(complete)
        retainPendingSuffix(suffix)
        return
      }
      process(chunk)
    },
    resume(): void {
      if (options.shouldPause?.() || (pendingInput === null && pausedCompleteInputBytes === 0)) {
        return
      }
      const input = pendingInput
      pendingInput = null
      if (pausedCompleteInput.length > 0) {
        const queued = pausedCompleteInput
        pausedCompleteInput = []
        pausedCompleteInputBytes = 0
        process(queued.join(''))
      }
      if (input !== null) {
        if (options.shouldPause?.()) {
          // A queued record may pause the consumer again. Keep the suffix
          // behind any newly queued records so it cannot overtake them.
          const queuedSuffix = pendingInput
          pendingInput = null
          retainPendingSuffix(`${queuedSuffix ?? ''}${input}`)
        } else {
          process(input)
        }
      }
    },
    reset(): void {
      clearLine()
      discardingOversizedLine = false
      pendingInput = null
      pausedCompleteInput = []
      pausedCompleteInputBytes = 0
      pausedCompleteInputOverflowed = false
    }
  }
}

export function encodeNdjson(msg: unknown, maxLineBytes = NDJSON_MAX_LINE_BYTES): string {
  const line = JSON.stringify(msg)
  const lineBytes = Buffer.byteLength(line, 'utf8')
  if (lineBytes > maxLineBytes) {
    throw new NdjsonLineTooLongError(lineBytes, maxLineBytes)
  }
  return `${line}\n`
}

export type NdjsonParser = {
  feed(chunk: string): void
  reset(): void
}

export type NdjsonParserOptions = {
  maxLineBytes?: number
}

export function createNdjsonParser(
  onMessage: (msg: unknown) => void,
  onError?: (err: Error) => void,
  options: NdjsonParserOptions = {}
): NdjsonParser {
  const parser = createIncrementalNdjsonFramer(
    (message) => onMessage(message),
    (rejected) => {
      onError?.(
        rejected.kind === 'invalid-json'
          ? rejected.error
          : new Error(
              `NDJSON line exceeds max ${rejected.maxLineBytes} bytes (${rejected.observedBytes} bytes received)`
            )
      )
    },
    options
  )
  return { feed: parser.feed, reset: parser.reset }
}
