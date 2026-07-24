import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'

// Why: 4096 UTF-16 code units encode to at most ~12KB UTF-8, safely under the
// 16KB TERMINAL_INPUT_CHUNK_MAX_BYTES cap without paying byte measurement on
// the hot input path.
export const TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS = 4096

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
}

function defaultYieldBetweenWrites(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function isCoalescibleText(text: string): boolean {
  return text.length <= TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS
}

export function createPtyInputWriteQueue(deps: PtyInputWriteQueueDeps): PtyInputWriteQueue {
  const yieldBetweenWrites = deps.yieldBetweenWrites ?? defaultYieldBetweenWrites
  let pending: PendingPtyInputWrite[] = []
  let drainPromise: Promise<void> | null = null

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const next = pending[0]
      if (!next) {
        pending.shift()
        continue
      }
      if (!deps.isWritable(next.id)) {
        pending.shift()
        continue
      }
      if (next.tooLarge !== false) {
        next.tooLarge = await Promise.resolve(next.tooLarge).catch(() => true)
        if (next.tooLarge) {
          pending.shift()
          continue
        }
        if (!deps.isWritable(next.id)) {
          pending.shift()
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
        pending.shift()
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
          pending.shift()
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
        pending.shift()
        continue
      }
      deps.write(next.id, chunk.value)
      const following = next.chunks.next()
      if (following.done) {
        pending.shift()
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
        pending.push({ id, text: data, tooLarge })
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
    }
  }
}
