import { reportPtyInputDrainFailure, writeAcceptedPtyChunk } from './pty-input-write-receipt'
import type { TerminalInputCall } from './terminal-input-call'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import {
  isCoalesciblePtyInput,
  notifyEligiblePtyInputWrite,
  TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS,
  type PendingPtyInputWrite,
  type PtyInputWriteQueue,
  type PtyInputWriteQueueDeps
} from './pty-input-write-queue-contract'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import {
  createHeadQueue,
  firstPendingPtyInputWrite,
  admitPtyInputReply,
  resetHeadQueue,
  shiftHeadQueue
} from './pty-input-write-head-queue'

export {
  PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES,
  PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS,
  TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS
} from './pty-input-write-queue-contract'

export function createPtyInputWriteQueue(deps: PtyInputWriteQueueDeps): PtyInputWriteQueue {
  const yieldBetweenWrites = deps.yieldBetweenWrites ?? yieldToEventLoop
  const pendingOrdinary = createHeadQueue()
  const pendingReplies = createHeadQueue()
  let pendingReplyCount = 0
  let pendingReplyCodeUnits = 0
  let eligibilityHead = 0
  let nextSequence = 0
  let generation = 0
  let failedGeneration: number | null = null
  let drainPromise: Promise<void> | null = null
  const pendingAcceptedCancels = new Set<() => void>()

  function advanceEligibility(): void {
    while (eligibilityHead < pendingOrdinary.items.length) {
      const item = pendingOrdinary.items[eligibilityHead]
      if (
        item &&
        (item.tooLarge !== false || failedGeneration === generation || !deps.isWritable(item.id))
      ) {
        return
      }
      eligibilityHead += 1
      if (item) {
        notifyEligiblePtyInputWrite(item)
      }
    }
  }

  function resetSequenceIfEmpty(): void {
    if (pendingOrdinary.items.length === 0 && pendingReplies.items.length === 0) {
      nextSequence = 0
    }
  }

  const firstPending = () => firstPendingPtyInputWrite(pendingOrdinary, pendingReplies)

  function shiftOrdinary(): PendingPtyInputWrite | undefined {
    const oldHead = pendingOrdinary.head
    const removed = shiftHeadQueue(pendingOrdinary)
    eligibilityHead =
      pendingOrdinary.head === 0
        ? Math.max(0, eligibilityHead - oldHead - 1)
        : Math.max(pendingOrdinary.head, eligibilityHead)
    resetSequenceIfEmpty()
    return removed
  }

  function shiftReply(): PendingPtyInputWrite | undefined {
    const removed = shiftHeadQueue(pendingReplies)
    if (removed) {
      pendingReplyCount -= 1
      pendingReplyCodeUnits -= removed.text.length
    }
    resetSequenceIfEmpty()
    return removed
  }

  function removePending(item: PendingPtyInputWrite, accepted?: boolean): void {
    if (item.replyOnly) {
      shiftReply()
    } else {
      shiftOrdinary()
    }
    if (accepted !== undefined) {
      item.resolveAccepted?.(accepted)
    }
  }

  function clearPending(): void {
    for (let index = pendingOrdinary.head; index < pendingOrdinary.items.length; index += 1) {
      pendingOrdinary.items[index]?.resolveAccepted?.(false)
    }
    resetHeadQueue(pendingOrdinary)
    eligibilityHead = 0
    resetHeadQueue(pendingReplies)
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
          removePending(next, false)
          continue
        }
        if (next.tooLarge !== false) {
          next.tooLarge = await Promise.resolve(next.tooLarge).catch(() => true)
          if (firstPending() !== next) {
            continue
          }
          if (next.tooLarge) {
            removePending(next, false)
            continue
          }
          if (!deps.isWritable(next.id)) {
            removePending(next, false)
            continue
          }
        }
        advanceEligibility()
        if (firstPending() !== next) {
          continue
        }
        // Coalesce validated small entries without changing bytes; per-item nested timers throttle dense wheel/repeat input to ≥4ms and replay gestures seconds late.
        if (next.chunks === undefined && isCoalesciblePtyInput(next)) {
          next.call?.onDispatch(next.id)
          let payload = next.text
          removePending(next)
          let peek: PendingPtyInputWrite | undefined
          while ((peek = firstPending())) {
            if (
              peek.id !== next.id ||
              peek.tooLarge !== false ||
              peek.chunks !== undefined ||
              !isCoalesciblePtyInput(peek) ||
              peek.inputKind !== next.inputKind ||
              payload.length + peek.text.length > TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS
            ) {
              break
            }
            peek.call?.onDispatch(peek.id)
            payload += peek.text
            removePending(peek)
          }
          deps.write(next.id, payload, next.inputKind)
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
          removePending(next, true)
          continue
        }
        const writeGeneration = generation
        next.call?.onDispatch(next.id)
        next.call = undefined
        const accepted = next.resolveAccepted
          ? await writeAcceptedPtyChunk(deps, pendingAcceptedCancels, next, chunk.value)
          : (deps.write(next.id, chunk.value, next.inputKind), true)
        if (generation !== writeGeneration || firstPending() !== next) {
          continue
        }
        if (!accepted) {
          clearPending()
          return
        }
        const following = next.chunks.next()
        if (following.done) {
          removePending(next, true)
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
      reportPtyInputDrainFailure(deps, failingId, error, failureIsCurrent)
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
    // Reserve the worker before drain() can invoke a reentrant write callback.
    drainPromise = Promise.resolve()
    drainPromise = drain().finally(finishDrain)
  }

  function enqueueInput(
    id: string,
    text: string,
    queryReply: boolean,
    inputKind: TerminalInputKind,
    resolveAccepted?: PendingPtyInputWrite['resolveAccepted'],
    call?: TerminalInputCall
  ): boolean {
    try {
      if (failedGeneration === generation || !deps.isWritable(id)) {
        resolveAccepted?.(false)
        return false
      }
      // Every query reply stays atomic so host-side ordering can classify it (#13892).
      const replyOnly = queryReply
      if (
        replyOnly &&
        !admitPtyInputReply(
          text,
          () => pendingReplyCount,
          () => pendingReplyCodeUnits,
          shiftReply
        )
      ) {
        return false
      }
      const tooLarge = replyOnly ? false : isTerminalInputTooLargeWithDeferredMeasurement(text)
      if (tooLarge === true) {
        resolveAccepted?.(false)
        return false
      }
      const item = {
        sequence: nextSequence,
        id,
        text,
        replyOnly,
        inputKind,
        tooLarge,
        resolveAccepted,
        call
      }
      nextSequence += 1
      if (replyOnly) {
        pendingReplies.items.push(item)
        pendingReplyCount += 1
        pendingReplyCodeUnits += text.length
      } else {
        pendingOrdinary.items.push(item)
      }
      advanceEligibility()
      scheduleDrain()
      return true
    } catch {
      resolveAccepted?.(false)
      return false
    }
  }

  return {
    enqueue(
      id: string,
      data: string,
      inputKind: TerminalInputKind,
      call?: TerminalInputCall
    ): boolean {
      return enqueueInput(id, data, false, inputKind, undefined, call)
    },

    enqueueQueryReply(id: string, data: string): boolean {
      return enqueueInput(id, data, true, 'query-reply')
    },

    enqueueAccepted: (id, data, inputKind, call) =>
      new Promise((resolve) => {
        enqueueInput(id, data, false, inputKind, resolve, call)
      }),

    async waitForDrain(): Promise<void> {
      while (drainPromise) {
        await drainPromise
      }
    },

    clear(): void {
      generation += 1
      failedGeneration = null
      clearPending()
      for (const cancel of pendingAcceptedCancels) {
        cancel()
      }
      pendingAcceptedCancels.clear()
    }
  }
}
