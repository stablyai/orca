import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from './native-chat-types'

export type NativeChatToolPair = {
  call?: NativeChatToolCallBlock
  result?: NativeChatToolResultBlock
}

type PendingCall = {
  slot: number
  callId: string | undefined
  previous?: PendingCall
  next?: PendingCall
  nextWithId?: PendingCall
}

type CallIdQueue = { first: PendingCall; last: PendingCall }

class PendingToolCalls {
  private first: PendingCall | undefined
  private last: PendingCall | undefined
  private byId: Map<string, CallIdQueue> | undefined

  get empty(): boolean {
    return this.first === undefined
  }

  add(slot: number, callId: string | undefined): void {
    const call: PendingCall = { slot, callId, previous: this.last }
    if (this.last) {
      this.last.next = call
    } else {
      this.first = call
    }
    this.last = call
    if (this.byId) {
      this.indexCall(call, this.byId)
    }
  }

  private indexCall(call: PendingCall, byId: Map<string, CallIdQueue>): void {
    if (call.callId === undefined) {
      return
    }
    const queue = byId.get(call.callId)
    if (queue) {
      queue.last.nextWithId = call
      queue.last = call
    } else {
      byId.set(call.callId, { first: call, last: call })
    }
  }

  take(callId: string | undefined): number | undefined {
    let call = this.first
    if (call && callId !== undefined && call.callId !== callId) {
      if (!this.byId) {
        const byId = new Map<string, CallIdQueue>()
        // Ordered results need only the FIFO; build the index when a named result misses its head.
        for (let pending: PendingCall | undefined = call; pending; pending = pending.next) {
          this.indexCall(pending, byId)
        }
        this.byId = byId
      }
      call = this.byId.get(callId)?.first
    }
    if (!call) {
      return undefined
    }
    if (call.previous) {
      call.previous.next = call.next
    } else {
      this.first = call.next
    }
    if (call.next) {
      call.next.previous = call.previous
    } else {
      this.last = call.previous
    }
    // The global oldest call is also the oldest of its ID, so both answers pop an ID head.
    if (this.byId && call.callId !== undefined) {
      const queue = this.byId.get(call.callId)
      if (queue && call.nextWithId) {
        queue.first = call.nextWithId
      } else {
        this.byId.delete(call.callId)
      }
    }
    if (!this.first) {
      this.byId = undefined
    }
    return call.slot
  }
}

/** Named results answer the oldest call with that ID; unnamed results answer the oldest call. */
export function pairToolBlocks(
  blocks: readonly NativeChatBlock[],
  limit = Infinity
): NativeChatToolPair[] {
  const pairs: NativeChatToolPair[] = []
  pairToolBlocksReportingUnpaired(blocks, limit, pairs)
  return pairs
}

export function unpairedToolResultIndices(blocks: readonly NativeChatBlock[]): ReadonlySet<number> {
  const unpaired = new Set<number>()
  pairToolBlocksReportingUnpaired(blocks, Infinity, undefined, (index) => unpaired.add(index))
  return unpaired
}

function pairToolBlocksReportingUnpaired(
  blocks: readonly NativeChatBlock[],
  limit: number,
  pairs?: NativeChatToolPair[],
  onUnpaired?: (index: number) => void
): void {
  let pairCount = 0
  const pending = new PendingToolCalls()
  for (let index = 0; index < blocks.length; index += 1) {
    if (pairCount >= limit && pending.empty) {
      break
    }
    const block = blocks[index]
    if (block.type === 'tool-call') {
      if (pairCount < limit) {
        pending.add(pairCount, block.callId)
        pairs?.push({ call: block })
        pairCount += 1
      }
      continue
    }
    if (block.type !== 'tool-result') {
      continue
    }
    const slot = pending.take(block.callId)
    if (slot === undefined) {
      onUnpaired?.(index)
      if (pairCount < limit) {
        pairs?.push({ result: block })
        pairCount += 1
      }
    } else if (pairs) {
      pairs[slot]!.result = block
    }
  }
}
