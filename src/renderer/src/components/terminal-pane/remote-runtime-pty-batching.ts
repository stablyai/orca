import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  getTerminalInputByteLength,
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'

export type RemoteRuntimePtyBatcher = {
  push: (data: string) => boolean
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
}

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
  let pending = ''
  let pendingBytes = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let validationTail: Promise<void> | null = null
  let validationVersion = 0

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const clear = (): void => {
    clearTimer()
    validationVersion += 1
    validationTail = null
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

  const enqueueValidatedInput = (data: string, tooLarge: false | Promise<boolean>): void => {
    const queuedVersion = validationVersion
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
        if (validationTail === nextTail) {
          validationTail = null
        }
      })
    validationTail = nextTail
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

      enqueueValidatedInput(data, tooLarge)
      return true
    },
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
