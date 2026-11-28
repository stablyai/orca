import { loadLazyWithRetry } from '@/app-shell/startup/lazy-with-retry'

// Whatever component loadLazyWithRetry accepts, without restating its constraint.
type LoadableComponent = Awaited<ReturnType<Parameters<typeof loadLazyWithRetry>[0]>>['default']

export type ChunkRequest<T> = {
  loaded: Promise<{ default: T }>
  /** The asker no longer needs the chunk; once nobody does, a failing load may not reload the window. */
  release: () => void
}

/**
 * One load per document however many hosts ask, so failures cannot multiply retries, and window
 * reload recovery only while some asker is still waiting. A failed load is forgotten so the next
 * request tries again; a successful one is kept.
 */
export function createSharedChunkLoad<T extends LoadableComponent>(
  factory: () => Promise<{ default: T }>,
  reloadKey: string
): () => ChunkRequest<T> {
  const waiting = new Set<symbol>()
  let loading: Promise<{ default: T }> | null = null
  return () => {
    const asker = Symbol(reloadKey)
    waiting.add(asker)
    let load = loading
    if (!load) {
      const started = loadLazyWithRetry(factory, {
        reloadKey,
        canRecover: () => waiting.size > 0
      })
      load = started
      loading = started
      started.catch(() => {
        if (loading === started) {
          loading = null
        }
      })
    }
    return { loaded: load, release: () => void waiting.delete(asker) }
  }
}
