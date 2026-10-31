import {
  PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES,
  PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS,
  type PendingPtyInputWrite
} from './pty-input-write-queue-contract'

/** Amortized-O(1) FIFO: shift by head index, compact once the dead prefix dominates. */
export type HeadQueue = { items: (PendingPtyInputWrite | undefined)[]; head: number }

export function createHeadQueue(): HeadQueue {
  return { items: [], head: 0 }
}

export function resetHeadQueue(queue: HeadQueue): void {
  queue.items = []
  queue.head = 0
}

export function peekHeadQueue(queue: HeadQueue): PendingPtyInputWrite | undefined {
  return queue.items[queue.head]
}

export function shiftHeadQueue(queue: HeadQueue): PendingPtyInputWrite | undefined {
  const removed = queue.items[queue.head]
  queue.items[queue.head] = undefined
  queue.head += 1
  if (queue.head === queue.items.length) {
    resetHeadQueue(queue)
  } else if (queue.head >= 1024 && queue.head * 2 >= queue.items.length) {
    queue.items = queue.items.slice(queue.head)
    queue.head = 0
  }
  return removed
}

export function firstPendingPtyInputWrite(
  pendingOrdinary: HeadQueue,
  pendingReplies: HeadQueue
): PendingPtyInputWrite | undefined {
  const ordinary = peekHeadQueue(pendingOrdinary)
  const reply = peekHeadQueue(pendingReplies)
  if (!ordinary) {
    return reply
  }
  if (!reply) {
    return ordinary
  }
  return ordinary.sequence < reply.sequence ? ordinary : reply
}

export function admitPtyInputReply(
  text: string,
  pendingCount: () => number,
  pendingCodeUnits: () => number,
  shiftReply: () => PendingPtyInputWrite | undefined
): boolean {
  if (text.length > PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS) {
    return false
  }
  while (
    pendingCount() >= PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES ||
    pendingCodeUnits() + text.length > PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS
  ) {
    if (!shiftReply()) {
      return false
    }
  }
  return true
}
