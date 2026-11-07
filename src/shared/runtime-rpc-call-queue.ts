import { abortSignalReason } from './abort-signal-reason'
import { REMOTE_RUNTIME_MAX_PREPARED_RPC_BYTES } from './remote-runtime/remote-runtime-memory-limits'

const DEFAULT_REMOTE_RUNTIME_CALL_CONCURRENCY = 8
const DEFAULT_REMOTE_RUNTIME_BACKGROUND_CALL_CONCURRENCY = 2
const REMOTE_RUNTIME_BULK_READ_CONCURRENCY = 2
export const RUNTIME_RPC_MAX_QUEUED_CALLS_PER_SELECTOR = 256
export const RUNTIME_RPC_MAX_QUEUED_CALLS_TOTAL = 2_048
export const RUNTIME_RPC_QUEUE_OVERLOAD_CODE = 'runtime_rpc_queue_overloaded'

export class RuntimeRpcCallQueueOverloadError extends Error {
  readonly code = RUNTIME_RPC_QUEUE_OVERLOAD_CODE

  constructor(readonly scope: 'selector' | 'global' | 'memory') {
    super('Remote runtime call queue is full; retry after current calls finish.')
    this.name = 'RuntimeRpcCallQueueOverloadError'
  }
}

type QueuedRuntimeCall<T> = {
  background: boolean
  retainedBytes: number
  /** Dropped when the call starts or is cancelled, so a retired call keeps no payload. */
  run: (() => Promise<T>) | null
  resolve: (value: T) => void
  reject: (error: unknown) => void
  /** Linked in its lane; unlinking clears this, so a later start or cancel finds nothing to do. */
  waiting: boolean
  signal?: AbortSignal
  onAbort?: () => void
  previous: QueuedRuntimeCall<unknown> | null
  next: QueuedRuntimeCall<unknown> | null
}

/** One priority's waiting calls, oldest first. A cancelled call is unlinked directly, so retiring
 *  many never searches or shifts the calls behind it. */
type RuntimeCallLane = {
  head: QueuedRuntimeCall<unknown> | null
  tail: QueuedRuntimeCall<unknown> | null
  size: number
}

type RuntimeCallQueue = {
  concurrency: number
  active: number
  backgroundActive: number
  foreground: RuntimeCallLane
  background: RuntimeCallLane
}

export function isBackgroundRuntimeMethod(method: string): boolean {
  return (
    method === 'hostedReview.forBranch' ||
    method === 'github.prForBranch' ||
    method === 'github.listWorkItems' ||
    method === 'github.countWorkItems' ||
    method === 'git.status' ||
    method === 'git.history' ||
    method === 'git.conflictOperation' ||
    method === 'git.branchCompare' ||
    method === 'git.upstreamStatus' ||
    method === 'worktree.prefetchCreateBase'
  )
}

// Slow worktree removal/model listing waits get a separate lane so foreground refresh/send slots remain free;
// background slots belong to status.
function isLongWaitRuntimeMethod(method: string): boolean {
  return method === 'worktree.rm' || method === 'agentSession.modelCatalog'
}

// Byte-range reads (media, paged files, downloads) are bulk: a playing video must not hold terminal or workspace slots.
function isBulkReadRuntimeMethod(method: string): boolean {
  return (
    method === 'files.readChunk' ||
    method === 'files.readDocPreviewChunk' ||
    method === 'files.readTerminalArtifactChunk'
  )
}

export class RuntimeRpcCallQueuePool {
  private readonly queues = new Map<string, RuntimeCallQueue>()
  private queuedCallCount = 0
  private retainedCallBytes = 0

  constructor(
    private readonly concurrency = DEFAULT_REMOTE_RUNTIME_CALL_CONCURRENCY,
    private readonly backgroundConcurrency = DEFAULT_REMOTE_RUNTIME_BACKGROUND_CALL_CONCURRENCY,
    private readonly maxQueuedPerSelector = RUNTIME_RPC_MAX_QUEUED_CALLS_PER_SELECTOR,
    private readonly maxQueuedTotal = RUNTIME_RPC_MAX_QUEUED_CALLS_TOTAL,
    private readonly maxRetainedBytes = REMOTE_RUNTIME_MAX_PREPARED_RPC_BYTES
  ) {}

  enqueue<T>(
    selector: string,
    method: string,
    run: () => Promise<T>,
    retainedBytes = 0,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(abortSignalReason(signal))
    }
    // Same concurrency bound, counted apart from the selector's other calls; global caps still apply.
    const bulkRead = isBulkReadRuntimeMethod(method)
    const queueKey = isLongWaitRuntimeMethod(method)
      ? `${selector}\u0000long-wait`
      : bulkRead
        ? `${selector}\u0000bulk-read`
        : selector
    if (this.queuedCallCount >= this.maxQueuedTotal) {
      return Promise.reject(new RuntimeRpcCallQueueOverloadError('global'))
    }
    const existingQueue = this.queues.get(queueKey)
    if (existingQueue && this.queuedCount(existingQueue) >= this.maxQueuedPerSelector) {
      return Promise.reject(new RuntimeRpcCallQueueOverloadError('selector'))
    }
    if (
      !Number.isSafeInteger(retainedBytes) ||
      retainedBytes < 0 ||
      this.retainedCallBytes + retainedBytes > this.maxRetainedBytes
    ) {
      return Promise.reject(new RuntimeRpcCallQueueOverloadError('memory'))
    }

    const queue = this.getQueue(
      queueKey,
      bulkRead ? Math.min(this.concurrency, REMOTE_RUNTIME_BULK_READ_CONCURRENCY) : this.concurrency
    )
    return new Promise<T>((resolve, reject) => {
      const call: QueuedRuntimeCall<T> = {
        background: isBackgroundRuntimeMethod(method),
        retainedBytes,
        run,
        resolve,
        reject,
        waiting: true,
        signal,
        previous: null,
        next: null
      }
      const lane = call.background ? queue.background : queue.foreground
      const entry = call as QueuedRuntimeCall<unknown>
      entry.previous = lane.tail
      if (lane.tail) {
        lane.tail.next = entry
      } else {
        lane.head = entry
      }
      lane.tail = entry
      lane.size += 1
      this.queuedCallCount += 1
      this.retainedCallBytes += retainedBytes
      if (signal) {
        call.onAbort = () => this.cancelQueuedCall(queueKey, queue, call)
        signal.addEventListener('abort', call.onAbort, { once: true })
      }
      this.pump(queueKey, queue)
    })
  }

  private getQueue(selector: string, concurrency: number): RuntimeCallQueue {
    let queue = this.queues.get(selector)
    if (!queue) {
      queue = {
        concurrency,
        active: 0,
        backgroundActive: 0,
        foreground: { head: null, tail: null, size: 0 },
        background: { head: null, tail: null, size: 0 }
      }
      this.queues.set(selector, queue)
    }
    return queue
  }

  private pump(selector: string, queue: RuntimeCallQueue): void {
    while (queue.active < queue.concurrency) {
      let call = this.take(queue.foreground)
      if (!call && queue.backgroundActive < this.backgroundConcurrency) {
        call = this.take(queue.background)
      }
      if (!call) {
        break
      }

      const run = call.run!
      call.run = null
      if (call.signal && call.onAbort) {
        call.signal.removeEventListener('abort', call.onAbort)
      }
      call.onAbort = undefined
      call.signal = undefined

      queue.active += 1
      if (call.background) {
        queue.backgroundActive += 1
      }
      // Decorative status refreshes must not stampede capacity shared with streams and workspace actions.
      let runPromise: Promise<unknown>
      try {
        runPromise = run()
      } catch (error) {
        // Start queued work immediately but route synchronous validation failures through cleanup.
        runPromise = Promise.reject(error)
      }
      void runPromise.then(call.resolve, call.reject).finally(() => {
        this.retainedCallBytes = Math.max(0, this.retainedCallBytes - call.retainedBytes)
        queue.active = Math.max(0, queue.active - 1)
        if (call.background) {
          queue.backgroundActive = Math.max(0, queue.backgroundActive - 1)
        }
        if (queue.active === 0 && this.isEmpty(queue)) {
          this.queues.delete(selector)
          return
        }
        this.pump(selector, queue)
      })
    }
  }

  private cancelQueuedCall<T>(
    selector: string,
    queue: RuntimeCallQueue,
    call: QueuedRuntimeCall<T>
  ): void {
    const signal = call.signal
    if (!call.waiting || !signal) {
      return
    }
    this.unlink(
      call.background ? queue.background : queue.foreground,
      call as QueuedRuntimeCall<unknown>
    )
    this.retainedCallBytes = Math.max(0, this.retainedCallBytes - call.retainedBytes)
    call.run = null
    call.onAbort = undefined
    call.signal = undefined
    call.reject(abortSignalReason(signal))
    if (queue.active === 0 && this.isEmpty(queue)) {
      this.queues.delete(selector)
      return
    }
    this.pump(selector, queue)
  }

  private take(lane: RuntimeCallLane): QueuedRuntimeCall<unknown> | undefined {
    const call = lane.head
    if (!call) {
      return undefined
    }
    this.unlink(lane, call)
    return call
  }

  private unlink(lane: RuntimeCallLane, call: QueuedRuntimeCall<unknown>): void {
    call.waiting = false
    if (call.previous) {
      call.previous.next = call.next
    } else {
      lane.head = call.next
    }
    if (call.next) {
      call.next.previous = call.previous
    } else {
      lane.tail = call.previous
    }
    call.previous = null
    call.next = null
    lane.size -= 1
    this.queuedCallCount = Math.max(0, this.queuedCallCount - 1)
  }

  private isEmpty(queue: RuntimeCallQueue): boolean {
    return queue.foreground.size === 0 && queue.background.size === 0
  }

  private queuedCount(queue: RuntimeCallQueue): number {
    return queue.foreground.size + queue.background.size
  }
}
