export type CombinedDiffLoadScheduler = {
  request: (index: number) => void
  reset: () => void
  dispose: () => void
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
  const pending: number[] = []
  const queued = new Set<number>()
  let active = 0
  let disposed = false
  let version = 0

  const drain = (drainVersion: number): void => {
    if (disposed || drainVersion !== version) {
      return
    }

    while (active < maxConcurrent) {
      const nextIndex = pending.shift()
      if (nextIndex === undefined) {
        return
      }

      active += 1
      void loadSection(nextIndex).finally(() => {
        queued.delete(nextIndex)
        if (disposed || drainVersion !== version) {
          return
        }
        active = Math.max(0, active - 1)
        schedule(() => drain(drainVersion))
      })
    }
  }

  return {
    request(index) {
      if (disposed || queued.has(index)) {
        return
      }
      queued.add(index)
      pending.push(index)
      const requestVersion = version
      schedule(() => drain(requestVersion))
    },
    reset() {
      disposed = false
      version += 1
      pending.length = 0
      queued.clear()
      active = 0
    },
    dispose() {
      disposed = true
      pending.length = 0
      queued.clear()
    }
  }
}
