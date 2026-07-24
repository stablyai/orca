export type CombinedDiffLoadScheduler = {
  request: (index: number) => void
  rerequest: (index: number) => void
  reset: () => void
  dispose: () => void
}

type PendingLoad = {
  index: number
  requestId: number
}

export function createCombinedDiffLoadScheduler({
  loadSection,
  schedule = (callback) => queueMicrotask(callback),
  // Why: a settled section usually mounts a Monaco DiffEditor. Serializing by
  // default keeps large lockfile-style diffs from stacking render work.
  maxConcurrent = 1
}: {
  loadSection: (index: number) => Promise<void>
  schedule?: (callback: () => void) => void
  maxConcurrent?: number
}): CombinedDiffLoadScheduler {
  const pending: PendingLoad[] = []
  const queuedRequestByIndex = new Map<number, number>()
  let active = 0
  let disposed = false
  let version = 0
  let nextRequestId = 0

  const drain = (drainVersion: number): void => {
    if (disposed || drainVersion !== version) {
      return
    }

    while (active < maxConcurrent) {
      const next = pending.shift()
      if (!next) {
        return
      }

      active += 1
      void loadSection(next.index).finally(() => {
        active = Math.max(0, active - 1)
        if (queuedRequestByIndex.get(next.index) === next.requestId) {
          queuedRequestByIndex.delete(next.index)
        }
        if (disposed) {
          return
        }
        const currentVersion = version
        schedule(() => drain(currentVersion))
      })
    }
  }

  const enqueue = (index: number): void => {
    if (disposed || queuedRequestByIndex.has(index)) {
      return
    }
    const requestId = ++nextRequestId
    queuedRequestByIndex.set(index, requestId)
    pending.push({ index, requestId })
    const requestVersion = version
    schedule(() => drain(requestVersion))
  }

  return {
    request(index) {
      enqueue(index)
    },
    rerequest(index) {
      if (disposed) {
        return
      }
      const requestId = queuedRequestByIndex.get(index)
      queuedRequestByIndex.delete(index)
      const pendingIndex = pending.findIndex((load) => load.requestId === requestId)
      if (pendingIndex !== -1) {
        pending.splice(pendingIndex, 1)
      }
      enqueue(index)
    },
    reset() {
      disposed = false
      version += 1
      // Why: don't reset `active`; stale loads still consume memory and I/O until they settle.
      pending.length = 0
      queuedRequestByIndex.clear()
    },
    dispose() {
      disposed = true
      pending.length = 0
      queuedRequestByIndex.clear()
    }
  }
}
