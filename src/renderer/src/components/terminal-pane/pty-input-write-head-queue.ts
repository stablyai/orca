import type { PendingPtyInputWrite } from './pty-input-write-queue-contract'

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
