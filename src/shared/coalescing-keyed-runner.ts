export type CoalescingKeyedRunner<T> = (
  key: string,
  shareKey: string,
  work: () => Promise<T>
) => Promise<T>

type QueuedRun<T> = {
  shareKey: string
  work: () => Promise<T>
  start: () => void
  result: Promise<T>
}

/**
 * At most one run per key at a time, in arrival order. A caller joins a queued, not yet started
 * run with the same `shareKey`, which then uses the latest joiner's `work`; otherwise it queues a
 * new run. So every result comes from a run of the caller's own `shareKey`, and a burst costs at
 * most one run per distinct `shareKey` beyond the one in flight.
 */
export function createCoalescingKeyedRunner<T>(): CoalescingKeyedRunner<T> {
  const queues = new Map<string, QueuedRun<T>[]>()

  const drain = async (key: string, queue: QueuedRun<T>[]): Promise<void> => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      run.start()
      await settled(run.result)
    }
    queues.delete(key)
  }

  return (key, shareKey, work) => {
    const queue = queues.get(key)
    const joinable = queue?.find((run) => run.shareKey === shareKey)
    if (joinable) {
      joinable.work = work
      return joinable.result
    }
    const run = createQueuedRun(shareKey, work)
    if (queue) {
      queue.push(run)
    } else {
      const fresh = [run]
      queues.set(key, fresh)
      void drain(key, fresh)
    }
    return run.result
  }
}

function createQueuedRun<T>(shareKey: string, work: () => Promise<T>): QueuedRun<T> {
  let start!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  const run: QueuedRun<T> = { shareKey, work, start, result: started.then(() => run.work()) }
  return run
}

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined
  )
}
