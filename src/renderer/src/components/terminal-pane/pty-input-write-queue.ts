import { yieldToEventLoop } from '../../../../shared/event-loop-yield'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import { needsCookedEchoSafeQueryReply } from '../../../../shared/terminal-query-reply'

// Why: 4096 UTF-16 code units encode to at most ~12KB UTF-8, safely under the
// 16KB TERMINAL_INPUT_CHUNK_MAX_BYTES cap without paying byte measurement on
// the hot input path.
export const TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS = 4096
// Match host delivery's reply ceiling while keeping all retained reply text under one PTY chunk.
export const PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES = 64
// Keep ≤ TERMINAL_INPUT_CHUNK_MAX_BYTES/3 so a reply is written and dropped in one drain step:
// admitReply evicts the head, and a half-written entry would truncate. Guarded by a unit test.
export const PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS =
  TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS

type PendingPtyInputWrite = {
  sequence: number
  id: string
  text: string
  replyOnly: boolean
  tooLarge: boolean | Promise<boolean>
  chunks?: Iterator<string>
  nextChunk?: string
}

export type PtyInputWriteQueue = {
  enqueue: (id: string, data: string) => boolean
  enqueueQueryReply: (id: string, data: string) => boolean
  waitForDrain: () => Promise<void>
  clear: () => void
}

export type PtyInputWriteQueueDeps = {
  isWritable: (id: string) => boolean
  write: (id: string, data: string) => void
  yieldBetweenWrites?: () => Promise<void>
  onDrainFailure?: (id: string) => void
}

function isCoalescibleInput(input: PendingPtyInputWrite): boolean {
  // Echo-risk replies stay atomic so host classifiers cannot miss them (#13137).
  return input.text.length <= TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS && !input.replyOnly
}

export function createPtyInputWriteQueue(deps: PtyInputWriteQueueDeps): PtyInputWriteQueue {
  const yieldBetweenWrites = deps.yieldBetweenWrites ?? yieldToEventLoop
  let pendingOrdinary: (PendingPtyInputWrite | undefined)[] = []
  let pendingOrdinaryHead = 0
  let pendingReplies: (PendingPtyInputWrite | undefined)[] = []
  let pendingReplyHead = 0
  let pendingReplyCount = 0
  let pendingReplyCodeUnits = 0
  let nextSequence = 0
  let generation = 0
  let failedGeneration: number | null = null
  let drainPromise: Promise<void> | null = null

  function compactOrdinary(): void {
    if (pendingOrdinaryHead === pendingOrdinary.length) {
      pendingOrdinary = []
      pendingOrdinaryHead = 0
    } else if (pendingOrdinaryHead >= 1024 && pendingOrdinaryHead * 2 >= pendingOrdinary.length) {
      pendingOrdinary = pendingOrdinary.slice(pendingOrdinaryHead)
      pendingOrdinaryHead = 0
    }
  }

  function compactReplies(): void {
    if (pendingReplyHead === pendingReplies.length) {
      pendingReplies = []
      pendingReplyHead = 0
    } else if (pendingReplyHead >= 1024 && pendingReplyHead * 2 >= pendingReplies.length) {
      pendingReplies = pendingReplies.slice(pendingReplyHead)
      pendingReplyHead = 0
    }
  }

  function resetSequenceIfEmpty(): void {
    if (pendingOrdinary.length === 0 && pendingReplies.length === 0) {
      nextSequence = 0
    }
  }

  function firstPending(): PendingPtyInputWrite | undefined {
    const ordinary = pendingOrdinary[pendingOrdinaryHead]
    const reply = pendingReplies[pendingReplyHead]
    if (!ordinary) {
      return reply
    }
    if (!reply) {
      return ordinary
    }
    return ordinary.sequence < reply.sequence ? ordinary : reply
  }

  function shiftOrdinary(): PendingPtyInputWrite | undefined {
    const removed = pendingOrdinary[pendingOrdinaryHead]
    pendingOrdinary[pendingOrdinaryHead] = undefined
    pendingOrdinaryHead += 1
    compactOrdinary()
    resetSequenceIfEmpty()
    return removed
  }

  function shiftReply(): PendingPtyInputWrite | undefined {
    const removed = pendingReplies[pendingReplyHead]
    pendingReplies[pendingReplyHead] = undefined
    pendingReplyHead += 1
    if (removed) {
      pendingReplyCount -= 1
      pendingReplyCodeUnits -= removed.text.length
    }
    compactReplies()
    resetSequenceIfEmpty()
    return removed
  }

  function removePending(item: PendingPtyInputWrite): void {
    if (item.replyOnly) {
      shiftReply()
    } else {
      shiftOrdinary()
    }
  }

  function admitReply(text: string): boolean {
    if (text.length > PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS) {
      return false
    }
    while (
      pendingReplyCount >= PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES ||
      pendingReplyCodeUnits + text.length > PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS
    ) {
      if (!shiftReply()) {
        return false
      }
    }
    return true
  }

  function clearPending(): void {
    pendingOrdinary = []
    pendingOrdinaryHead = 0
    pendingReplies = []
    pendingReplyHead = 0
    pendingReplyCount = 0
    pendingReplyCodeUnits = 0
    nextSequence = 0
  }

  async function drain(): Promise<void> {
    let failureGeneration = generation
    // Why: the drain yields, so the owner may rebind before the failure surfaces; report the id that actually failed.
    let failingId: string | null = null
    try {
      let next: PendingPtyInputWrite | undefined
      while ((next = firstPending())) {
        failureGeneration = generation
        failingId = next.id
        if (!deps.isWritable(next.id)) {
          removePending(next)
          continue
        }
        if (next.tooLarge !== false) {
          next.tooLarge = await Promise.resolve(next.tooLarge).catch(() => true)
          if (firstPending() !== next) {
            continue
          }
          if (next.tooLarge) {
            removePending(next)
            continue
          }
          if (!deps.isWritable(next.id)) {
            removePending(next)
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
        if (next.chunks === undefined && isCoalescibleInput(next)) {
          let payload = next.text
          removePending(next)
          let peek: PendingPtyInputWrite | undefined
          while ((peek = firstPending())) {
            if (
              peek.id !== next.id ||
              peek.tooLarge !== false ||
              peek.chunks !== undefined ||
              !isCoalescibleInput(peek) ||
              payload.length + peek.text.length > TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS
            ) {
              break
            }
            payload += peek.text
            removePending(peek)
          }
          deps.write(next.id, payload)
          if (firstPending()) {
            await yieldBetweenWrites()
          }
          continue
        }
        next.chunks ??= iterateTerminalInputChunks(next.text)
        const chunk =
          next.nextChunk === undefined ? next.chunks.next() : { done: false, value: next.nextChunk }
        next.nextChunk = undefined
        if (chunk.done) {
          removePending(next)
          continue
        }
        deps.write(next.id, chunk.value)
        const following = next.chunks.next()
        if (following.done) {
          removePending(next)
        } else {
          next.nextChunk = following.value
        }
        if (firstPending()) {
          await yieldBetweenWrites()
        }
      }
    } catch (error) {
      const failureIsCurrent = generation === failureGeneration
      if (failureIsCurrent) {
        clearPending()
        failedGeneration = generation
      }
      console.warn('[pty-input-write-queue] drain failed:', error)
      if (failureIsCurrent && failingId !== null) {
        try {
          deps.onDrainFailure?.(failingId)
        } catch (recoveryError) {
          console.warn('[pty-input-write-queue] failure handler failed:', recoveryError)
        }
      }
    }
  }

  function scheduleDrain(): void {
    if (drainPromise) {
      return
    }
    const finishDrain = (): void => {
      drainPromise = null
      if (firstPending()) {
        scheduleDrain()
      }
    }
    drainPromise = drain().finally(finishDrain)
  }

  function enqueueInput(id: string, data: string, queryReply: boolean): boolean {
    try {
      if (failedGeneration === generation) {
        return false
      }
      const replyOnly = queryReply && needsCookedEchoSafeQueryReply(data)
      if (replyOnly && !admitReply(data)) {
        return false
      }
      const tooLarge = replyOnly ? false : isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (tooLarge === true) {
        return false
      }
      const item = { sequence: nextSequence, id, text: data, replyOnly, tooLarge }
      nextSequence += 1
      if (replyOnly) {
        pendingReplies.push(item)
        pendingReplyCount += 1
        pendingReplyCodeUnits += data.length
      } else {
        pendingOrdinary.push(item)
      }
      scheduleDrain()
      return true
    } catch {
      return false
    }
  }

  return {
    enqueue(id: string, data: string): boolean {
      return enqueueInput(id, data, false)
    },

    enqueueQueryReply(id: string, data: string): boolean {
      return enqueueInput(id, data, true)
    },

    async waitForDrain(): Promise<void> {
      while (drainPromise) {
        await drainPromise
      }
    },

    clear(): void {
      generation += 1
      failedGeneration = null
      clearPending()
    }
  }
}
