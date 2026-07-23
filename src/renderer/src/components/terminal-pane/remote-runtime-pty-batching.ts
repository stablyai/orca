import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  getTerminalInputByteLength,
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'

export type RemoteRuntimePtyBatcher = {
  push: (data: string) => boolean
  hasPendingValidation: () => boolean
  drain: () => Promise<void>
  takePending: () => string
  flush: () => void
  clear: () => void
}

export type RemoteRuntimeViewportBatcher = {
  queue: (cols: number, rows: number) => void
  flush: () => void
  clear: () => void
}

export type RemoteRuntimePtyTextBatcherOptions = {
  maxPendingBytes?: number
  maxBytes?: number
  maxValidationQueuedCodeUnits?: number
  maxValidationQueuedEntries?: number
}

export const REMOTE_RUNTIME_PTY_VALIDATION_QUEUE_MAX_ENTRIES = 4_096

export function createRemoteRuntimePtyTextBatcher(
  delayMs: number,
  onFlush: (text: string) => void,
  options: RemoteRuntimePtyTextBatcherOptions = {}
): RemoteRuntimePtyBatcher {
  const maxPendingBytes = getPositiveByteLimit(
    options.maxPendingBytes,
    TERMINAL_INPUT_CHUNK_MAX_BYTES
  )
  const maxBytes = getPositiveByteLimit(options.maxBytes, TERMINAL_INPUT_MAX_BYTES)
  const maxValidationQueuedCodeUnits = getPositiveByteLimit(
    options.maxValidationQueuedCodeUnits,
    maxBytes
  )
  const maxValidationQueuedEntries = getPositiveByteLimit(
    options.maxValidationQueuedEntries,
    REMOTE_RUNTIME_PTY_VALIDATION_QUEUE_MAX_ENTRIES
  )
  let pending = ''
  let pendingBytes = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let validationTail: Promise<void> | null = null
  let validationVersion = 0
  let validationQueuedCodeUnits = 0
  let validationQueuedEntries = 0

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const clear = (): void => {
    clearTimer()
    pending = ''
    pendingBytes = 0
    validationVersion += 1
    validationTail = null
    validationQueuedCodeUnits = 0
    validationQueuedEntries = 0
  }

  const flush = (): void => {
    const text = takePending()
    if (text) {
      onFlush(text)
    }
  }

  const takePending = (): string => {
    const text = pending
    pending = ''
    pendingBytes = 0
    clearTimer()
    return text
  }

  const queuePending = (chunk: string, chunkBytes: number): void => {
    pending += chunk
    pendingBytes += chunkBytes
    if (!timer) {
      timer = setTimeout(flush, delayMs)
    }
  }

  const pushValidatedInput = (data: string): void => {
    for (const chunk of iterateTerminalInputChunks(data, maxPendingBytes)) {
      const chunkBytes = getTerminalInputByteLength(chunk)
      if (pending && pendingBytes + chunkBytes > maxPendingBytes) {
        flush()
      }
      if (!pending && chunkBytes >= maxPendingBytes) {
        // Why: remote paste chunks must not be coalesced back into one large
        // binary frame or terminal.send payload by the short input debounce.
        onFlush(chunk)
        continue
      }
      queuePending(chunk, chunkBytes)
    }
  }

  const enqueueValidatedInput = (data: string, tooLarge: false | Promise<boolean>): boolean => {
    if (
      validationQueuedEntries >= maxValidationQueuedEntries ||
      validationQueuedCodeUnits + data.length > maxValidationQueuedCodeUnits
    ) {
      return false
    }
    const queuedVersion = validationVersion
    validationQueuedEntries += 1
    validationQueuedCodeUnits += data.length
    const previousTail = validationTail ?? Promise.resolve()
    const guardedTail = previousTail.then(async () => {
      if (validationVersion !== queuedVersion) {
        return
      }
      if (tooLarge !== false && (await tooLarge.catch(() => true))) {
        return
      }
      if (validationVersion === queuedVersion) {
        pushValidatedInput(data)
      }
    })
    const nextTail = guardedTail
      .catch(() => {})
      .finally(() => {
        if (validationVersion === queuedVersion) {
          validationQueuedEntries -= 1
          validationQueuedCodeUnits -= data.length
        }
        if (validationTail === nextTail) {
          validationTail = null
        }
      })
    validationTail = nextTail
    return true
  }

  const drain = async (): Promise<void> => {
    const tail = validationTail
    if (tail) {
      await tail
    }
  }

  return {
    push(data: string): boolean {
      if (!data) {
        return true
      }

      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data, maxBytes)
      if (tooLarge === true) {
        return false
      }

      if (tooLarge === false && validationTail === null) {
        pushValidatedInput(data)
        return true
      }

      return enqueueValidatedInput(data, tooLarge)
    },
    // Why: earlier input can be mid async byte-length validation and not yet in
    // `pending`. `takePending()` cannot see it, so callers that must preserve
    // byte order (sendInputImmediate) check this before bypassing the queue.
    hasPendingValidation: (): boolean => validationTail !== null,
    drain,
    takePending,
    flush,
    clear
  }
}

function getPositiveByteLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? fallback) : fallback
}

export function createRemoteRuntimeViewportBatcher(
  delayMs: number,
  onFlush: (cols: number, rows: number) => void
): RemoteRuntimeViewportBatcher {
  let pending: { cols: number; rows: number } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // Why: also drop the queued viewport so a later flush()/reuse can't emit a
    // stale resize after the batcher was cleared on teardown/resubscribe.
    pending = null
  }

  const flush = (): void => {
    const viewport = pending
    pending = null
    clear()
    if (viewport) {
      onFlush(viewport.cols, viewport.rows)
    }
  }

  return {
    queue(cols: number, rows: number): void {
      pending = { cols, rows }
      if (!timer) {
        timer = setTimeout(flush, delayMs)
      }
    },
    flush,
    clear
  }
}
