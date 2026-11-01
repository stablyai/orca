export type CombinedDiffLoadRequest = { viewportOnly?: boolean }

export type CombinedDiffLoadScheduler = {
  request: (index: number, options?: CombinedDiffLoadRequest) => void
  rerequest: (index: number, options?: CombinedDiffLoadRequest) => void
  reset: () => void
  dispose: () => void
}

export function createCombinedDiffLoadScheduler({
  loadSection,
  getRenderedIndices,
  isSectionExpanded = () => true,
  schedule = (callback) => queueMicrotask(callback),
  // Section completion mounts Monaco; serialize by default to avoid stacking large-diff render work.
  maxConcurrent = 1
}: {
  loadSection: (index: number) => Promise<void>
  getRenderedIndices?: () => ReadonlySet<number>
  isSectionExpanded?: (index: number) => boolean
  schedule?: (callback: () => void) => void
  maxConcurrent?: number
}): CombinedDiffLoadScheduler {
  const pending = new Map<number, { viewportOnly: boolean; order: number }>()
  const pendingViewportOnly = new Set<number>()
  const queued = new Set<number>()
  let active = 0
  let disposed = false
  let version = 0
  let order = 0

  const isSectionRendered = (index: number): boolean =>
    (getRenderedIndices?.().has(index) ?? true) && isSectionExpanded(index)

  const prunePending = (): void => {
    for (const index of pendingViewportOnly) {
      if (!isSectionRendered(index)) {
        pending.delete(index)
        pendingViewportOnly.delete(index)
        queued.delete(index)
      }
    }
  }

  const drain = (drainVersion: number): void => {
    if (disposed || drainVersion !== version) {
      return
    }

    prunePending()
    while (active < maxConcurrent) {
      let nextIndex = pending.keys().next().value
      let nextOrder = Infinity
      for (const index of getRenderedIndices?.() ?? []) {
        const request = pending.get(index)
        if (request && request.order < nextOrder && isSectionExpanded(index)) {
          nextIndex = index
          nextOrder = request.order
        }
      }
      if (nextIndex === undefined) {
        return
      }
      pending.delete(nextIndex)
      pendingViewportOnly.delete(nextIndex)

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

  const enqueue = (index: number, { viewportOnly = false }: CombinedDiffLoadRequest = {}): void => {
    if (disposed) {
      return
    }
    prunePending()
    if (queued.has(index)) {
      // An explicit request keeps a queued viewport request alive after scrolling away.
      const request = pending.get(index)
      if (!viewportOnly && request) {
        request.viewportOnly = false
        pendingViewportOnly.delete(index)
      }
      return
    }
    if (viewportOnly && !isSectionRendered(index)) {
      return
    }
    queued.add(index)
    pending.set(index, { viewportOnly, order: order++ })
    if (viewportOnly) {
      pendingViewportOnly.add(index)
    }
    const requestVersion = version
    schedule(() => drain(requestVersion))
  }

  return {
    request(index, options) {
      enqueue(index, options)
    },
    rerequest(index, options) {
      if (disposed) {
        return
      }
      const retained = pending.get(index)?.viewportOnly === false
      queued.delete(index)
      pending.delete(index)
      pendingViewportOnly.delete(index)
      enqueue(index, retained ? { viewportOnly: false } : options)
    },
    reset() {
      disposed = false
      version += 1
      pending.clear()
      pendingViewportOnly.clear()
      queued.clear()
      active = 0
      order = 0
    },
    dispose() {
      disposed = true
      pending.clear()
      pendingViewportOnly.clear()
      queued.clear()
    }
  }
}
