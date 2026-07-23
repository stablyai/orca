import {
  TERMINAL_INPUT_MAX_BYTES,
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'

// Why: 4096 UTF-16 code units encode to at most ~12KB UTF-8, safely under the
// 16KB TERMINAL_INPUT_CHUNK_MAX_BYTES cap without paying byte measurement on
// the hot input path.
export const TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS = 4096
export const PTY_INPUT_WRITE_QUEUE_MAX_PENDING_ITEMS = 4_096

type PendingPtyInputWrite = {
  id: string
  text: string
  tooLarge: boolean | Promise<boolean>
  chunks?: Iterator<string>
  nextChunk?: string
}

export type PtyInputWriteQueue = {
  enqueue: (id: string, data: string) => boolean
  waitForDrain: () => Promise<void>
  clear: () => void
}

export type PtyInputWriteQueueDeps = {
  isWritable: (id: string) => boolean
  write: (id: string, data: string) => void
  yieldBetweenWrites?: () => Promise<void>
  maxPendingItems?: number
  maxPendingCodeUnits?: number
}

function defaultYieldBetweenWrites(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function isCoalescibleText(text: string): boolean {
  return text.length <= TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS
}

export function createPtyInputWriteQueue(deps: PtyInputWriteQueueDeps): PtyInputWriteQueue {
  const yieldBetweenWrites = deps.yieldBetweenWrites ?? defaultYieldBetweenWrites
  const maxPendingItems = positiveLimit(
    deps.maxPendingItems,
    PTY_INPUT_WRITE_QUEUE_MAX_PENDING_ITEMS
  )
  const maxPendingCodeUnits = positiveLimit(deps.maxPendingCodeUnits, TERMINAL_INPUT_MAX_BYTES)
  let pending: PendingPtyInputWrite[] = []
  let pendingCodeUnits = 0
  let drainPromise: Promise<void> | null = null
  let clearVersion = 0

  function shiftPending(): PendingPtyInputWrite | undefined {
    const shifted = pending.shift()
    if (shifted) {
      pendingCodeUnits -= shifted.text.length
    }
    return shifted
  }

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const next = pending[0]
      if (!next) {
        shiftPending()
        continue
      }
      if (!deps.isWritable(next.id)) {
        shiftPending()
        continue
      }
      if (next.tooLarge !== false) {
        const validationVersion = clearVersion
        next.tooLarge = await Promise.resolve(next.tooLarge).catch(() => true)
        if (validationVersion !== clearVersion) {
          continue
        }
        if (next.tooLarge) {
          shiftPending()
          continue
        }
        if (!deps.isWritable(next.id)) {
          shiftPending()
          continue
        }
      }
      // Why: dense input streams (SGR wheel reports during trackpad momentum,
      // key auto-repeat) enqueue one tiny item per event. Writing one item per
      // macrotask turn lets Chromium's nested-timer clamp pace the drain at
      // ≥4ms per item, so a fast gesture's reports reach the PTY seconds after
      // the gesture ended and the TUI visibly replays them one by one.
      // Coalescing consecutive validated small items into a single write keeps
      // the PTY byte stream identical while draining the backlog in one turn.
      if (next.chunks === undefined && isCoalescibleText(next.text)) {
        let payload = next.text
        shiftPending()
        while (pending.length > 0) {
          const peek = pending[0]
          if (
            !peek ||
            peek.id !== next.id ||
            peek.tooLarge !== false ||
            peek.chunks !== undefined ||
            !isCoalescibleText(peek.text) ||
            payload.length + peek.text.length > TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS
          ) {
            break
          }
          payload += peek.text
          shiftPending()
        }
        deps.write(next.id, payload)
        if (pending.length > 0) {
          await yieldBetweenWrites()
        }
        continue
      }
      next.chunks ??= iterateTerminalInputChunks(next.text)
      const chunk =
        next.nextChunk === undefined ? next.chunks.next() : { done: false, value: next.nextChunk }
      next.nextChunk = undefined
      if (chunk.done) {
        shiftPending()
        continue
      }
      deps.write(next.id, chunk.value)
      const following = next.chunks.next()
      if (following.done) {
        shiftPending()
      } else {
        next.nextChunk = following.value
      }
      if (pending.length > 0) {
        await yieldBetweenWrites()
      }
    }
  }

  function scheduleDrain(): void {
    if (drainPromise) {
      return
    }
    drainPromise = drain().finally(() => {
      drainPromise = null
      if (pending.length > 0) {
        scheduleDrain()
      }
    })
  }

  return {
    enqueue(id: string, data: string): boolean {
      try {
        const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
        if (tooLarge === true) {
          return false
        }
        if (
          pending.length >= maxPendingItems ||
          pendingCodeUnits + data.length > maxPendingCodeUnits
        ) {
          return false
        }
        pending.push({ id, text: data, tooLarge })
        pendingCodeUnits += data.length
        scheduleDrain()
        return true
      } catch {
        return false
      }
    },

    async waitForDrain(): Promise<void> {
      while (drainPromise) {
        await drainPromise
      }
    },

    clear(): void {
      pending = []
      pendingCodeUnits = 0
      clearVersion += 1
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? fallback) : fallback
}
