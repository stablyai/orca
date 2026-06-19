const DEFAULT_REMOTE_RUNTIME_CALL_CONCURRENCY = 8
const DEFAULT_REMOTE_RUNTIME_BACKGROUND_CALL_CONCURRENCY = 2

type QueuedRuntimeCall<T> = {
  background: boolean
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type RuntimeCallQueue = {
  active: number
  backgroundActive: number
  foreground: QueuedRuntimeCall<unknown>[]
  foregroundHead: number
  background: QueuedRuntimeCall<unknown>[]
  backgroundHead: number
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

export class RuntimeRpcCallQueuePool {
  private readonly queues = new Map<string, RuntimeCallQueue>()

  constructor(
    private readonly concurrency = DEFAULT_REMOTE_RUNTIME_CALL_CONCURRENCY,
    private readonly backgroundConcurrency = DEFAULT_REMOTE_RUNTIME_BACKGROUND_CALL_CONCURRENCY
  ) {}

  enqueue<T>(selector: string, method: string, run: () => Promise<T>): Promise<T> {
    const queue = this.getQueue(selector)
    return new Promise<T>((resolve, reject) => {
      const call: QueuedRuntimeCall<T> = {
        background: isBackgroundRuntimeMethod(method),
        run,
        resolve,
        reject
      }
      const targetQueue = call.background ? queue.background : queue.foreground
      targetQueue.push(call as QueuedRuntimeCall<unknown>)
      this.pump(selector, queue)
    })
  }

  private getQueue(selector: string): RuntimeCallQueue {
    let queue = this.queues.get(selector)
    if (!queue) {
      queue = {
        active: 0,
        backgroundActive: 0,
        foreground: [],
        foregroundHead: 0,
        background: [],
        backgroundHead: 0
      }
      this.queues.set(selector, queue)
    }
    return queue
  }

  private pump(selector: string, queue: RuntimeCallQueue): void {
    while (queue.active < this.concurrency) {
      let call = this.takeForeground(queue)
      if (!call && queue.backgroundActive < this.backgroundConcurrency) {
        call = this.takeBackground(queue)
      }
      if (!call) {
        break
      }

      queue.active += 1
      if (call.background) {
        queue.backgroundActive += 1
      }
      // Why: runtime streams and worktree actions share transport capacity with
      // per-card status refreshes, so decorative calls must not stampede it.
      let runPromise: Promise<unknown>
      try {
        runPromise = call.run()
      } catch (error) {
        // Why: callers rely on queued work starting immediately, but sync
        // validation errors must still flow through the cleanup path.
        runPromise = Promise.reject(error)
      }
      void runPromise.then(call.resolve, call.reject).finally(() => {
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

  private takeForeground(queue: RuntimeCallQueue): QueuedRuntimeCall<unknown> | undefined {
    if (queue.foregroundHead >= queue.foreground.length) {
      return undefined
    }
    const call = queue.foreground[queue.foregroundHead]
    queue.foregroundHead += 1
    this.compactForeground(queue)
    return call
  }

  private takeBackground(queue: RuntimeCallQueue): QueuedRuntimeCall<unknown> | undefined {
    if (queue.backgroundHead >= queue.background.length) {
      return undefined
    }
    const call = queue.background[queue.backgroundHead]
    queue.backgroundHead += 1
    this.compactBackground(queue)
    return call
  }

  private compactForeground(queue: RuntimeCallQueue): void {
    if (queue.foregroundHead <= 32 || queue.foregroundHead * 2 < queue.foreground.length) {
      return
    }
    // Why: large remote-runtime refresh bursts can queue many calls;
    // head indexes avoid O(n) shift costs while compaction releases closures.
    queue.foreground.splice(0, queue.foregroundHead)
    queue.foregroundHead = 0
  }

  private compactBackground(queue: RuntimeCallQueue): void {
    if (queue.backgroundHead <= 32 || queue.backgroundHead * 2 < queue.background.length) {
      return
    }
    queue.background.splice(0, queue.backgroundHead)
    queue.backgroundHead = 0
  }

  private isEmpty(queue: RuntimeCallQueue): boolean {
    return (
      queue.foregroundHead >= queue.foreground.length &&
      queue.backgroundHead >= queue.background.length
    )
  }
}
