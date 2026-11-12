/** Queue tails never reject; operation failures propagate only to their enqueuer. */
export function runKeyedSerializedOperation<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.then(operation)
  const queued = current.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, queued)

  const clear = (): void => {
    if (queues.get(key) === queued) {
      queues.delete(key)
    }
  }
  queued.then(clear, clear)
  return current
}

export function getKeyedSerializedQueueTail(
  queues: Map<string, Promise<void>>,
  key: string
): Promise<void> {
  return queues.get(key) ?? Promise.resolve()
}
