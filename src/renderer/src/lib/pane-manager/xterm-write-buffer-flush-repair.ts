// Why this exists: xterm 6.1 runs WriteBuffer.flushSync on every resize, and
// that flush shifts from index 0 instead of _bufferOffset. Chunks a time-sliced
// _innerWrite already parsed (and their callbacks) are parsed AGAIN, so a fit
// landing between slices replays old TUI output over the screen — garbled rows
// that persist until the TUI's next full redraw (a manual resize). Still
// unfixed upstream as of 6.1.0-beta.315. This trims the parsed prefix first and
// skips flushes that would re-enter a chunk mid-parse. Delete once xterm's
// flushSync honours _bufferOffset.

type WriteChunk = string | Uint8Array

type WriteBufferInternals = {
  _writeBuffer: WriteChunk[]
  _callbacks: unknown[]
  _bufferOffset: number
  _isSyncWriting: boolean
  _action: (data: WriteChunk, promiseResult?: boolean) => unknown
  _innerWrite: (...args: unknown[]) => void
  flushSync: () => void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWriteBufferInternals(value: unknown): value is WriteBufferInternals {
  return (
    isObject(value) &&
    Array.isArray(value._writeBuffer) &&
    Array.isArray(value._callbacks) &&
    typeof value._bufferOffset === 'number' &&
    typeof value._isSyncWriting === 'boolean' &&
    typeof value._action === 'function' &&
    typeof value._innerWrite === 'function' &&
    typeof value.flushSync === 'function'
  )
}

function readWriteBuffer(terminal: unknown): WriteBufferInternals | null {
  const core = isObject(terminal) ? terminal._core : undefined
  const writeBuffer = isObject(core) ? core._writeBuffer : undefined
  return isWriteBufferInternals(writeBuffer) ? writeBuffer : null
}

function isThenable(value: unknown): boolean {
  return isObject(value) && typeof value.then === 'function'
}

/** Returns false when the vendored xterm no longer has the expected internals. */
export function installXtermWriteBufferFlushRepair(terminal: unknown): boolean {
  const writeBuffer = readWriteBuffer(terminal)
  if (!writeBuffer) {
    return false
  }
  const originalAction = writeBuffer._action
  const originalInnerWrite = writeBuffer._innerWrite
  const originalFlushSync = writeBuffer.flushSync
  let actionDepth = 0
  let innerWriteDepth = 0
  let parserPausedOnPromise = false

  writeBuffer._action = (data, promiseResult) => {
    actionDepth += 1
    try {
      const result = originalAction(data, promiseResult)
      parserPausedOnPromise = isThenable(result)
      return result
    } finally {
      actionDepth -= 1
    }
  }
  writeBuffer._innerWrite = function (...args: unknown[]): void {
    innerWriteDepth += 1
    try {
      originalInnerWrite.apply(writeBuffer, args)
    } finally {
      innerWriteDepth -= 1
    }
  }
  writeBuffer.flushSync = function (): void {
    if (writeBuffer._isSyncWriting) {
      originalFlushSync.call(writeBuffer)
      return
    }
    // Why: inside a parse, a write callback or an async pause, the active loop still owns the
    // queue; resetting it here re-runs a chunk or drops writes the callback queues next.
    if (actionDepth > 0 || innerWriteDepth > 0 || parserPausedOnPromise) {
      return
    }
    const parsedCount = writeBuffer._bufferOffset
    if (parsedCount > 0 && parsedCount <= writeBuffer._writeBuffer.length) {
      writeBuffer._writeBuffer.splice(0, parsedCount)
      writeBuffer._callbacks.splice(0, parsedCount)
      writeBuffer._bufferOffset = 0
    }
    originalFlushSync.call(writeBuffer)
  }
  return true
}
