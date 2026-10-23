import { ownRetainedString } from './own-retained-string'

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
      droppedCompleteRecords?: true
    }
  | { kind: 'invalid-json'; line: string; error: Error }

export type IncrementalNdjsonFramer = {
  feed(chunk: string): void
  resume(): void
  reset(): void
  /** Once input has ended: the unterminated last line, never parsed as a record. */
  takeTail(): string
}

export type IncrementalNdjsonFramerOptions = {
  maxLineBytes?: number
  shouldPause?: () => boolean
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

// Why: a strict slice is a V8 SlicedString that pins all of `source`; the whole string needs no copy.
function detachFrom(part: string, source: string): string {
  return part.length === source.length ? part : ownRetainedString(part)
}

/** Incremental main-process NDJSON framing with bounded unterminated-line retention. */
export function createIncrementalNdjsonFramer(
  onRecord: (record: unknown, line: string) => void,
  onRejected: (rejected: NdjsonRejectedRecord) => void,
  options: IncrementalNdjsonFramerOptions = {}
): IncrementalNdjsonFramer {
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
  // No line can exceed an unbounded limit, so measuring segments and keeping a rejection prefix is dead work.
  const unbounded = maxLineBytes === Number.POSITIVE_INFINITY
  const maxPendingInputBytes = Math.max(REJECTED_LINE_PREFIX_MAX_BYTES, maxLineBytes * 2)
  let lineSegments: string[] = []
  let lineBytes = 0
  let prefixSegments: string[] = []
  let prefixBytes = 0
  let discardingOversizedLine = false
  let discardingPausedSuffix = false
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

  const queuePausedCompleteInput = (complete: string, source: string): void => {
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
        droppedCompleteRecords: true,
        prefix: ownRetainedString(boundedUtf8Prefix(complete, REJECTED_LINE_PREFIX_MAX_BYTES))
      })
      return
    }
    pausedCompleteInput.push(detachFrom(complete, source))
    pausedCompleteInputBytes += completeBytes
  }

  const retainPendingSuffix = (suffix: string, source: string): void => {
    if (suffix.length === 0) {
      pendingInput = null
      return
    }
    const suffixBytes = Buffer.byteLength(suffix, 'utf8')
    if (suffixBytes > maxPendingInputBytes) {
      pendingInput = null
      discardingPausedSuffix = true
      onRejected({
        kind: 'line-too-long',
        maxLineBytes: maxPendingInputBytes,
        observedBytes: suffixBytes,
        prefix: ownRetainedString(boundedUtf8Prefix(suffix, REJECTED_LINE_PREFIX_MAX_BYTES))
      })
      return
    }
    pendingInput = detachFrom(suffix, source)
  }

  const retainPausedInput = (input: string, source = input): void => {
    const newlineIndex = input.lastIndexOf('\n')
    queuePausedCompleteInput(newlineIndex === -1 ? '' : input.slice(0, newlineIndex + 1), source)
    retainPendingSuffix(newlineIndex === -1 ? input : input.slice(newlineIndex + 1), source)
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
        const segmentBytes = unbounded ? 0 : Buffer.byteLength(segment, 'utf8')
        const nextLineBytes = lineBytes + segmentBytes
        if (nextLineBytes > maxLineBytes) {
          rememberPrefix(segment, segmentBytes)
          const rejected: NdjsonRejectedRecord = {
            kind: 'line-too-long',
            maxLineBytes,
            observedBytes: nextLineBytes,
            prefix: ownRetainedString(prefixSegments.join(''))
          }
          clearLine()
          discardingOversizedLine = !hasNewline
          onRejected(rejected)
        } else if (!hasNewline) {
          const pending = detachFrom(segment, input)
          if (!unbounded) {
            rememberPrefix(pending, segmentBytes)
          }
          lineSegments.push(pending)
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
              onRejected({
                kind: 'invalid-json',
                line,
                error: error instanceof Error ? error : new Error(String(error))
              })
              continue
            }
            onRecord(parsed, line)
          }
        }
      }

      if (options.shouldPause?.() && cursor < input.length) {
        retainPausedInput(input.slice(cursor), input)
        return
      }
    }
  }

  return {
    feed(chunk): void {
      if (pausedCompleteInputBytes > 0 && !options.shouldPause?.()) {
        const queued = pausedCompleteInput
        pausedCompleteInput = []
        pausedCompleteInputBytes = 0
        process(queued.join(''))
      }
      const endedPausedSuffix = discardingPausedSuffix
      // The dropped tail follows the queued records; only new bytes can finish it.
      if (discardingPausedSuffix) {
        const newlineIndex = chunk.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        discardingPausedSuffix = false
        chunk = chunk.slice(newlineIndex + 1)
      }
      if (chunk.length === 0) {
        return
      }

      if (pendingInput !== null) {
        retainPausedInput(pendingInput + chunk)
        return
      }
      if ((pausedCompleteInputBytes > 0 || endedPausedSuffix) && options.shouldPause?.()) {
        retainPausedInput(chunk)
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
          const suffix = `${queuedSuffix ?? ''}${input}`
          retainPendingSuffix(suffix, suffix)
        } else {
          process(input)
        }
      }
    },
    takeTail(): string {
      const tail =
        discardingOversizedLine || discardingPausedSuffix
          ? ''
          : `${lineSegments.join('')}${pendingInput ?? ''}`
      clearLine()
      pendingInput = null
      return tail
    },
    reset(): void {
      clearLine()
      discardingOversizedLine = false
      discardingPausedSuffix = false
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

export type NdjsonParser = Pick<IncrementalNdjsonFramer, 'feed' | 'reset'>

export type NdjsonParserOptions = Pick<IncrementalNdjsonFramerOptions, 'maxLineBytes'>

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
